// Direct messages: conversations of 2 to 8 workspace members, started from Odin Chat's "New
// message" picker. The members are fixed when a conversation is made, so the same people always
// reach the same one; a new member means a new conversation. Posts, replies, tags and attachments
// work as in channels and reuse their records (chat.repository.js). Guests never reach these
// routes, and can't be members: only people with a membership in the workspace can be picked.
//
// Anyone outside a conversation gets the same 404 as for one that doesn't exist. Inside it, every
// member may post and reply; authors edit and delete their own posts.
import { supportsLargeFiles } from '../../lib/files/file-storage.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { mentionedActors, resolveMentions } from '../requirements/mentions/mention-tokens.js';
import { MAX_POSTS_PAGE, POSTS_PAGE_SIZE, decodePostCursor, encodePostCursor, presentPost } from '../channels/channels.service.js';
import { closePoll, pollBody, preparePoll, readPoll, savePoll, votePoll, withPolls } from '../channels/polls.service.js';
import { reactionsFor, requireReplyTo, setReaction } from '../channels/post-reactions.js';
import { cancelUpload, completeUpload, describeUpload, DEFAULT_FILE_UPLOAD_MAX_BYTES, findOwnUpload, getDownloadUrl, signUploadParts, startUpload } from '../vault/large-files.service.js';
import { getPreviewUrl } from '../vault/file-preview.service.js';
import { memberPrincipal } from '../notifications/notifications.service.js';
import { DM_TARGET_TYPE, MAX_DIRECT_MEMBERS } from './chat.repository.js';

export const MAX_DIRECT_ATTACHMENTS = 10;

export function tenantIdOf(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

const notFound = () => new HttpError(404, 'Conversation not found.');

/** The other members' names, in the order they joined: "Ada Admin, Mo Member". */
export function conversationTitle(conversation, viewerId) {
  const others = conversation.members.filter((member) => member.userId !== viewerId);
  return (others.length ? others : conversation.members).map((member) => member.name || 'Former member').join(', ');
}

/**
 * The conversation as the channel screens read a channel (name, canPost, canUpload), with its
 * members and counts.
 */
function presentConversation(conversation, viewerId, extra = {}) {
  const me = conversation.members.find((member) => member.userId === viewerId);
  return {
    archivedAt: null,
    canPost: true,
    createdAt: conversation.createdAt,
    id: conversation.id,
    isGroup: conversation.members.length > 2,
    lastPostAt: conversation.lastPostAt ?? null,
    lastReadAt: me?.lastReadAt ?? null,
    members: conversation.members.map((member) => ({ id: member.userId, name: member.name || 'Former member' })),
    mentionCount: conversation.mentionCount ?? 0,
    name: conversationTitle(conversation, viewerId),
    title: conversationTitle(conversation, viewerId),
    unreadCount: conversation.unreadCount ?? 0,
    ...extra,
  };
}

// The context the channel helpers read (presentPost): every member collaborates, nobody moderates.
function contextFor(user, tenantId) {
  return { canCollaborate: true, canDecide: false, principal: { id: user.id, name: user.name ?? '', type: 'user' }, tenantId };
}

/** The conversation, when the caller is in it; 404 otherwise. */
export async function requireConversation(deps, user, conversationId) {
  const tenantId = tenantIdOf(user);
  const conversation = await deps.projectRepository.getDirectConversation({ conversationId: String(conversationId ?? ''), tenantId });
  if (!conversation || !conversation.members.some((member) => member.userId === user.id)) throw notFound();
  return { conversation, ctx: contextFor(user, tenantId), tenantId };
}

/** The caller's conversations, latest activity first. */
export async function listDirectConversations(deps, user) {
  const tenantId = tenantIdOf(user);
  const listed = await deps.projectRepository.listDirectConversationsForUser({ tenantId, userId: user.id });
  return listed
    .map((conversation) => presentConversation(conversation, user.id))
    .sort((left, right) => String(right.lastPostAt ?? right.createdAt).localeCompare(String(left.lastPostAt ?? left.createdAt)));
}

/** Workspace members the caller can message: everyone with a membership, but themselves. */
export async function listDirectMessagePeople(deps, user) {
  const tenantId = tenantIdOf(user);
  const members = await deps.projectRepository.listWorkspaceMembers({ tenantId });
  return { ok: true, people: members.filter((member) => member.id !== user.id).map((member) => ({ email: member.email, id: member.id, name: member.name })) };
}

/** Opens the conversation with these people, starting it if it is new. */
export async function startDirectConversation(deps, user, { memberIds = [] } = {}) {
  const tenantId = tenantIdOf(user);
  const others = [...new Set(memberIds.map(String))].filter((id) => id !== user.id);
  if (!others.length) throw new HttpError(400, 'Choose at least one person.', { details: { code: 'members_required' } });
  if (others.length + 1 > MAX_DIRECT_MEMBERS) throw new HttpError(400, `A conversation can have up to ${MAX_DIRECT_MEMBERS} people.`, { details: { code: 'too_many_members', max: MAX_DIRECT_MEMBERS } });
  const workspace = new Set((await deps.projectRepository.listWorkspaceMembers({ tenantId })).map((member) => member.id));
  const outside = others.filter((id) => !workspace.has(id));
  if (outside.length) throw new HttpError(400, 'Direct messages are for people in this workspace.', { details: { code: 'not_workspace_members', userIds: outside } });
  const { conversation, created } = await deps.projectRepository.createDirectConversation({ createdBy: user.id, memberIds: [user.id, ...others], tenantId });
  return { conversation: presentConversation(conversation, user.id), created, ok: true };
}

export async function getDirectConversationForUser(deps, user, conversationId) {
  const { conversation } = await requireConversation(deps, user, conversationId);
  const listed = (await listDirectConversations(deps, user)).find((entry) => entry.id === conversation.id);
  return { conversation: listed ?? presentConversation(conversation, user.id), ok: true };
}

// The members other than the caller, as the mention picker and resolveMentions read them.
function peopleOf(conversation, ctx) {
  return conversation.members.filter((member) => member.userId !== ctx.principal.id).map((member) => ({ actorId: member.userId, actorType: 'user', email: member.email, name: member.name || 'Team member' }));
}

export async function listDirectMentionables(deps, user, conversationId) {
  const { conversation, ctx } = await requireConversation(deps, user, conversationId);
  return { ok: true, people: peopleOf(conversation, ctx).map((person) => ({ detail: 'Team', kind: 'team', name: person.name, ref: `user:${person.actorId}` })).sort((left, right) => left.name.localeCompare(right.name)) };
}

async function conversationFiles(deps, ctx, conversationId, user) {
  return deps.projectRepository.listFiles({ projectId: conversationId, targetId: conversationId, targetType: DM_TARGET_TYPE, tenantId: ctx.tenantId, user });
}

async function attachmentsFor(deps, ctx, { conversationId, posts, user }) {
  const links = await deps.projectRepository.listPostFileIds({ postIds: posts.map((post) => post.id) });
  const byPost = new Map();
  if (!links.length) return byPost;
  const files = new Map((await conversationFiles(deps, ctx, conversationId, user)).map((file) => [file.id, file]));
  for (const link of links) {
    const file = files.get(link.fileId);
    if (!file) continue;
    const list = byPost.get(link.postId) ?? [];
    list.push({ contentType: file.contentType, fileName: file.fileName, fileSize: file.fileSize, folderId: null, id: file.id, scanStatus: file.scanStatus, version: file.version });
    byPost.set(link.postId, list);
  }
  return byPost;
}

/** A page of the conversation: top-level posts newest first, each with its replies. */
export async function listDirectPosts(deps, user, conversationId, { before = null, limit = POSTS_PAGE_SIZE } = {}) {
  const { conversation, ctx, tenantId } = await requireConversation(deps, user, conversationId);
  const page = await deps.projectRepository.listPosts({ before: decodePostCursor(before), limit: Math.min(MAX_POSTS_PAGE, limit), targetId: conversation.id, targetType: DM_TARGET_TYPE, tenantId });
  const attachments = await attachmentsFor(deps, ctx, { conversationId: conversation.id, posts: [...page.posts, ...page.replies], user });
  const reactions = await reactionsFor(deps.projectRepository, { posts: [...page.posts, ...page.replies], principal: ctx.principal, tenantId });
  const extras = await withPolls(deps, ctx, [...page.posts, ...page.replies]);
  const repliesOf = new Map();
  for (const reply of page.replies) repliesOf.set(reply.parentId, [...(repliesOf.get(reply.parentId) ?? []), reply]);
  return {
    canPost: true,
    channel: presentConversation(conversation, user.id),
    nextCursor: page.hasMore && page.posts.length ? encodePostCursor(page.posts.at(-1)) : null,
    ok: true,
    posts: page.posts.map((post) => presentPost(post, ctx, { attachments, extras, reactions, replies: repliesOf.get(post.id) ?? [] })),
  };
}

function requireBody(body, attachments) {
  const text = String(body ?? '').trim();
  if (!text && !attachments) throw new HttpError(400, 'Write a message or attach a file.', { details: { code: 'post_empty' } });
  return text;
}

async function requirePost(deps, { conversation, tenantId }, postId) {
  const post = await deps.projectRepository.getPost({ postId, tenantId });
  if (!post || post.targetType !== DM_TARGET_TYPE || post.targetId !== conversation.id) throw new HttpError(404, 'Message not found.');
  return post;
}

export async function createDirectPost(deps, user, conversationId, input) {
  const place = await requireConversation(deps, user, conversationId);
  const { conversation, ctx, tenantId } = place;
  if (input.parentId) {
    const parent = await requirePost(deps, place, input.parentId).catch(() => { throw new HttpError(404, 'The message you are replying to is not here.'); });
    if (parent.parentId) throw new HttpError(400, 'Replies go one level deep. Reply to the first message instead.', { details: { code: 'reply_depth' } });
    if (parent.deletedAt) throw new HttpError(409, 'That message was deleted.', { details: { code: 'post_deleted' } });
  }
  const replyToId = await requireReplyTo(deps.projectRepository, { parentId: input.parentId ?? null, replyToId: input.replyToId ?? null, targetId: conversation.id, targetType: DM_TARGET_TYPE, tenantId });
  const fileIds = [...new Set(input.fileIds ?? [])];
  if (fileIds.length > MAX_DIRECT_ATTACHMENTS) throw new HttpError(400, `A message can carry up to ${MAX_DIRECT_ATTACHMENTS} files.`, { details: { code: 'too_many_attachments' } });
  if (fileIds.length) {
    const here = new Set((await conversationFiles(deps, ctx, conversation.id, user)).map((file) => file.id));
    const outside = fileIds.filter((fileId) => !here.has(fileId));
    if (outside.length) throw new HttpError(400, 'Attach files uploaded to this conversation.', { details: { code: 'attachment_not_in_conversation', fileIds: outside } });
  }
  const poll = preparePoll(input);
  const resolved = resolveMentions(requireBody(pollBody(input.body, poll), fileIds.length), { people: peopleOf(conversation, ctx) });
  const post = await deps.projectRepository.createDirectPost({
    fileIds,
    post: { authorId: user.id, authorType: 'user', body: resolved.body, parentId: input.parentId ?? null, replyToId, targetId: conversation.id, tenantId },
  });
  await savePoll(deps, ctx, post, poll);
  // Everyone else in the conversation hears of it (modules/notifications), as a mention if tagged.
  await deps.notifications?.notifyDirectMessage({ author: { id: user.id, name: user.name ?? '' }, conversation, mentioned: resolved.mentioned, post, tenantId });
  // The writer has read the conversation up to their post, and its notifications with it.
  await deps.projectRepository.markDirectConversationRead({ conversationId: conversation.id, userId: user.id });
  await readNotifications(deps, user, conversation.id);
  const attachments = await attachmentsFor(deps, ctx, { conversationId: conversation.id, posts: [post], user });
  return { conversationId: conversation.id, mentioned: resolved.mentioned.map((entry) => entry.actorId), ok: true, post: presentPost(post, ctx, { attachments, extras: await withPolls(deps, ctx, [post]) }) };
}

export async function updateDirectPost(deps, user, conversationId, postId, input) {
  const place = await requireConversation(deps, user, conversationId);
  const post = await requirePost(deps, place, postId);
  if (post.deletedAt) throw new HttpError(409, 'That message was deleted.', { details: { code: 'post_deleted' } });
  if (post.authorType !== 'user' || post.authorId !== user.id) throw new HttpError(403, 'Only the author can edit a message.', { details: { code: 'not_author' } });
  const attachments = (await deps.projectRepository.listPostFileIds({ postIds: [postId] })).length;
  const resolved = resolveMentions(requireBody(input.body, attachments), { people: peopleOf(place.conversation, place.ctx) });
  const saved = await deps.projectRepository.updateDirectPost({ body: resolved.body, postId, tenantId: place.tenantId });
  if (!saved) throw new HttpError(409, 'That message was deleted.', { details: { code: 'post_deleted' } });
  const before = new Set(mentionedActors(post.body).map((entry) => entry.actorRef));
  const added = resolved.mentioned.filter((entry) => !before.has(entry.actorRef));
  if (added.length) await deps.notifications?.notifyDirectMessage({ author: { id: user.id, name: user.name ?? '' }, conversation: place.conversation, isEdit: true, mentioned: added, post: saved, tenantId: place.tenantId });
  const files = await attachmentsFor(deps, place.ctx, { conversationId: place.conversation.id, posts: [saved], user });
  const reactions = await reactionsFor(deps.projectRepository, { posts: [saved], principal: place.ctx.principal, tenantId: place.tenantId });
  return { conversationId: place.conversation.id, mentioned: added.map((entry) => entry.actorId), ok: true, post: presentPost(saved, place.ctx, { attachments: files, extras: await withPolls(deps, place.ctx, [saved]), reactions }) };
}

// Polls in a conversation (polls.service.js): everyone in it votes; the author closes it.
async function pollPlace(deps, user, conversationId, postId) {
  const place = await requireConversation(deps, user, conversationId);
  const post = await requirePost(deps, place, postId);
  return { ...place, post };
}

export async function getDirectPoll(deps, user, conversationId, postId) {
  const place = await pollPlace(deps, user, conversationId, postId);
  return { conversationId: place.conversation.id, ok: true, poll: await readPoll(deps, place.ctx, place.post), postId };
}

export async function voteDirectPoll(deps, user, conversationId, postId, { answer }) {
  const place = await pollPlace(deps, user, conversationId, postId);
  return { conversationId: place.conversation.id, ok: true, poll: await votePoll(deps, place.ctx, place.post, answer), postId };
}

export async function closeDirectPoll(deps, user, conversationId, postId) {
  const place = await pollPlace(deps, user, conversationId, postId);
  return { conversationId: place.conversation.id, ok: true, poll: await closePoll(deps, place.ctx, place.post), postId };
}

/** Adds or removes the caller's emoji on a message in a conversation they are in. */
export async function setDirectPostReaction(deps, user, conversationId, postId, { emoji, reacted }) {
  const place = await requireConversation(deps, user, conversationId);
  const post = await requirePost(deps, place, postId);
  const reactions = await setReaction(deps.projectRepository, { emoji, post, principal: place.ctx.principal, reacted, tenantId: place.tenantId });
  return { conversationId: place.conversation.id, ok: true, postId, reactions: reactions.get(postId) ?? [] };
}

export async function deleteDirectPost(deps, user, conversationId, postId) {
  const place = await requireConversation(deps, user, conversationId);
  const post = await requirePost(deps, place, postId);
  if (post.authorType !== 'user' || post.authorId !== user.id) throw new HttpError(403, 'Only the author can delete a message.', { details: { code: 'not_author' } });
  if (post.deletedAt) return { conversationId: place.conversation.id, ok: true, post: presentPost(post, place.ctx) };
  const saved = await deps.projectRepository.deleteDirectPost({ postId, tenantId: place.tenantId, userId: user.id });
  return { conversationId: place.conversation.id, ok: true, post: presentPost(saved ?? post, place.ctx) };
}

export async function markDirectConversationRead(deps, user, conversationId) {
  const { conversation } = await requireConversation(deps, user, conversationId);
  const lastReadAt = await deps.projectRepository.markDirectConversationRead({ conversationId: conversation.id, userId: user.id });
  // Opening the conversation reads its notifications.
  await readNotifications(deps, user, conversation.id);
  return { lastReadAt, ok: true, unreadCount: 0 };
}

async function readNotifications(deps, user, conversationId) {
  const principal = memberPrincipal(user);
  if (principal) await deps.notifications?.markRead(principal, { conversationId });
}

// --- files: uploaded in parts into the workspace's file storage, under the conversation ---------

export function directFileStorage(large) {
  return {
    canDeleteVersions: false,
    maxUploadBytes: Number(large.fileUploadMaxBytes ?? DEFAULT_FILE_UPLOAD_MAX_BYTES),
    ok: true,
    storage: null,
    uploadsByParts: supportsLargeFiles(large.fileStorage),
  };
}

function presentFile(file) {
  return {
    contentType: file.contentType,
    createdAt: file.createdAt,
    fileName: file.fileName,
    fileSize: file.fileSize,
    id: file.id,
    scanStatus: file.scanStatus,
    targetId: file.targetId,
    targetType: file.targetType,
    updatedAt: file.updatedAt,
    uploadedBy: file.uploadedBy ? { id: file.uploadedBy.id ?? null, name: file.uploadedBy.name ?? '' } : null,
    version: file.version ?? 1,
  };
}

export async function listDirectFiles(deps, user, conversationId) {
  const { conversation, ctx } = await requireConversation(deps, user, conversationId);
  return { canWrite: true, files: (await conversationFiles(deps, ctx, conversation.id, user)).map(presentFile), ok: true };
}

async function requireDirectFile(deps, user, conversationId, fileId) {
  const place = await requireConversation(deps, user, conversationId);
  const file = await deps.projectRepository.getFileRecord({ fileId, tenantId: place.tenantId });
  if (!file || file.targetType !== DM_TARGET_TYPE || file.targetId !== place.conversation.id) throw new HttpError(404, 'File not found.');
  return { ...place, file };
}

/** Starts an upload into the conversation. New versions of a file are not offered here. */
export async function startDirectUpload(deps, large, user, conversationId, input) {
  const { conversation, tenantId } = await requireConversation(deps, user, conversationId);
  if (input.fileId) throw new HttpError(400, 'Files in a conversation get no new versions. Attach it again instead.', { details: { code: 'versions_unavailable' } });
  return startUpload(large, { projectId: conversation.id, tenantId, user }, { ...input, confirmEditing: false, folderId: null, targetId: conversation.id, targetType: DM_TARGET_TYPE });
}

// The caller's own upload, still into this conversation.
async function requireDirectUpload(deps, user, conversationId, uploadId) {
  const { conversation, tenantId } = await requireConversation(deps, user, conversationId);
  const upload = await findOwnUpload(deps, { projectId: conversation.id, tenantId, uploadId, userId: user.id });
  if (upload.targetType !== DM_TARGET_TYPE || upload.targetId !== conversation.id) throw new HttpError(404, 'Upload not found.');
  return { conversation, tenantId, upload };
}

export async function getDirectUpload(deps, large, user, conversationId, uploadId) {
  const { upload } = await requireDirectUpload(deps, user, conversationId, uploadId);
  return describeUpload(large, { upload });
}

export async function signDirectUploadParts(deps, large, user, conversationId, uploadId, input) {
  const { tenantId, upload } = await requireDirectUpload(deps, user, conversationId, uploadId);
  return signUploadParts(large, { tenantId, upload }, input);
}

export async function completeDirectUpload(deps, large, user, conversationId, uploadId) {
  const { tenantId, upload } = await requireDirectUpload(deps, user, conversationId, uploadId);
  // Two files of one name in a conversation are kept side by side, never as versions.
  const result = await completeUpload(large, { tenantId, upload, user }, { keepBoth: true });
  return { ...result, file: presentFile(result.file) };
}

export async function cancelDirectUpload(deps, large, user, conversationId, uploadId) {
  const { tenantId, upload } = await requireDirectUpload(deps, user, conversationId, uploadId);
  return cancelUpload(large, { tenantId, upload });
}

export async function getDirectDownloadUrl(deps, large, user, conversationId, fileId, options) {
  const { tenantId } = await requireDirectFile(deps, user, conversationId, fileId);
  return getDownloadUrl(large, { fileId, tenantId }, options);
}

export async function getDirectPreviewUrl(deps, large, user, conversationId, fileId, options) {
  const { tenantId } = await requireDirectFile(deps, user, conversationId, fileId);
  return getPreviewUrl(large, { fileId, tenantId }, options);
}
