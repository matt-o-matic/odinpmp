// Reactions and replies to a reply. Used by channel posts, file comments and direct
// messages alike.
import { HttpError } from '../../lib/errors/http-error.js';

/** One person's distinct emoji on one post, and a post's distinct emoji, at most. */
export const MAX_REACTIONS_PER_PERSON = 20;
export const MAX_EMOJI_PER_POST = 50;
/** Names listed under each emoji; the count says how many more. */
export const REACTION_NAMES_SHOWN = 20;

// An emoji is a short run of emoji code points: pictographs, skin tones, the zero-width joiner,
// variation selector 16, keycaps, flag letters and flag tags. Text never passes.
const EMOJI_PARTS = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[#*0-9]|‍|️|⃣|[\u{E0020}-\u{E007F}])+$/u;
const EMOJI_CORE = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|⃣/u;

// Emoji lists add variation selector 16 to some emoji that show as emoji without it (👍️ for 👍).
// It is dropped there, so one emoji is stored one way. The app does the same (lib/channels/reactions.js).
const TRAILING_SELECTOR = /^(\p{Emoji_Presentation}(?:\p{Emoji_Modifier})?)️$/u;
export function canonicalEmoji(value) {
  const emoji = String(value ?? '').normalize('NFC').trim();
  return emoji.replace(TRAILING_SELECTOR, '$1');
}

/** The emoji as stored, or a 400 when it is not one. */
export function normalizeEmoji(value) {
  const emoji = canonicalEmoji(value);
  if (!emoji || emoji.length > 32 || !EMOJI_PARTS.test(emoji) || !EMOJI_CORE.test(emoji)) {
    throw new HttpError(400, 'Pick an emoji to react with.', { details: { code: 'invalid_emoji' } });
  }
  return emoji;
}

/** Reactions by post id: [{ emoji, count, mine, people: [{ id, name, type, isViewer? }] }], first used first. */
export function summarizeReactions(rows, principal) {
  const byPost = new Map();
  for (const row of rows) {
    const list = byPost.get(row.postId) ?? new Map();
    const entry = list.get(row.emoji) ?? { count: 0, emoji: row.emoji, mine: false, people: [] };
    entry.count += 1;
    const isViewer = Boolean(principal) && row.principalType === principal.type && String(row.principalId) === String(principal.id);
    if (isViewer) entry.mine = true;
    // The viewer is always listed, so the app can say "You".
    if (entry.people.length < REACTION_NAMES_SHOWN || isViewer) {
      entry.people.push({ id: row.principalId, name: row.name || (row.principalType === 'stakeholder' ? 'Guest' : 'Former member'), type: row.principalType, ...(isViewer ? { isViewer: true } : {}) });
    }
    list.set(row.emoji, entry);
    byPost.set(row.postId, list);
  }
  return new Map([...byPost].map(([postId, list]) => [postId, [...list.values()]]));
}

/** The reactions of these posts for the person looking, by post id. Deleted posts have none. */
export async function reactionsFor(repository, { posts, principal, tenantId }) {
  const ids = posts.filter((post) => !post.deletedAt).map((post) => post.id);
  if (!ids.length || !repository.listPostReactions) return new Map();
  return summarizeReactions(await repository.listPostReactions({ postIds: ids, tenantId }), principal);
}

/**
 * Adds or removes one person's emoji on a post the caller may react to (checked by the caller),
 * within the limits. Returns the post's reactions afterwards.
 */
export async function setReaction(repository, { emoji, post, principal, reacted, tenantId }) {
  if (post.deletedAt) throw new HttpError(409, 'That message was deleted.', { details: { code: 'post_deleted' } });
  const value = normalizeEmoji(emoji);
  if (reacted) {
    const current = await repository.listPostReactions({ postIds: [post.id], tenantId });
    const mine = current.filter((row) => row.principalType === principal.type && String(row.principalId) === String(principal.id));
    if (!mine.some((row) => row.emoji === value)) {
      if (mine.length >= MAX_REACTIONS_PER_PERSON) throw new HttpError(409, `You can add up to ${MAX_REACTIONS_PER_PERSON} reactions to a message.`, { details: { code: 'too_many_reactions' } });
      if (!current.some((row) => row.emoji === value) && new Set(current.map((row) => row.emoji)).size >= MAX_EMOJI_PER_POST) {
        throw new HttpError(409, 'This message has as many different reactions as it can hold. Add to one that is there.', { details: { code: 'too_many_reactions' } });
      }
    }
  }
  await repository.setPostReaction({ emoji: value, postId: post.id, principal, reacted: Boolean(reacted), tenantId });
  return reactionsFor(repository, { posts: [post], principal, tenantId });
}

/**
 * The reply a new reply answers (replyToId): another reply in the same thread, not deleted. A
 * reply to the thread's first post needs no replyToId; one sent anyway is dropped.
 */
export async function requireReplyTo(repository, { parentId, replyToId, targetId, targetType, tenantId }) {
  if (!replyToId || replyToId === parentId) return null;
  if (!parentId) throw new HttpError(400, 'Only a reply can answer another reply.', { details: { code: 'reply_to_without_thread' } });
  const quoted = await repository.getPost({ postId: replyToId, tenantId });
  if (!quoted || quoted.targetType !== targetType || quoted.targetId !== targetId || quoted.parentId !== parentId) {
    throw new HttpError(400, 'You can only answer a reply in the same thread.', { details: { code: 'reply_to_other_thread' } });
  }
  if (quoted.deletedAt) throw new HttpError(409, 'That message was deleted.', { details: { code: 'post_deleted' } });
  return quoted.id;
}
