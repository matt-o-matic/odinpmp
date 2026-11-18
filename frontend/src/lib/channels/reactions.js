// Reactions and replies to a reply (docs/engagements/plan.md, Reactions; Replies to a reply). The
// server keeps one reaction per post, person and emoji and sends each post's reactions as
// [{ emoji, count, mine, people: [{ id, name, type }] }]; a reply that answers another reply
// carries replyToId, and the app shows a short quote of that reply above it.

/** The picker's first row, also offered without opening it. */
export const QUICK_REACTIONS = Object.freeze([
  { emoji: '👍', label: 'thumbs up' },
  { emoji: '👎', label: 'thumbs down' },
  { emoji: '😂', label: 'laughing' },
  { emoji: '❤️', label: 'heart' },
  { emoji: '🎉', label: 'celebrate' },
  { emoji: '👀', label: 'eyes' },
  { emoji: '✅', label: 'done' },
  { emoji: '🙏', label: 'thank you' },
]);

// emojibase groups, in its order. 2 (skin tone and hair components) is left out.
export const EMOJI_GROUPS = Object.freeze([
  { icon: '😀', id: 0, label: 'Smileys and emotion' },
  { icon: '👋', id: 1, label: 'People and body' },
  { icon: '🐻', id: 3, label: 'Animals and nature' },
  { icon: '🍔', id: 4, label: 'Food and drink' },
  { icon: '✈️', id: 5, label: 'Travel and places' },
  { icon: '⚽', id: 6, label: 'Activities' },
  { icon: '💡', id: 7, label: 'Objects' },
  { icon: '❤️', id: 8, label: 'Symbols' },
  { icon: '🏁', id: 9, label: 'Flags' },
]);

// Emoji lists add variation selector 16 to some emoji that show as emoji without it (👍️ for 👍).
// It is dropped there, as the server does (post-reactions.js), so one emoji is one reaction.
const TRAILING_SELECTOR = /^(\p{Emoji_Presentation}(?:\p{Emoji_Modifier})?)️$/u;
export function canonicalEmoji(value) {
  return String(value ?? '').normalize('NFC').trim().replace(TRAILING_SELECTOR, '$1');
}

/** The picker's catalogue from emojibase's compact list: groups with their emoji, in order. */
export function buildEmojiCatalog(entries = []) {
  const byGroup = new Map(EMOJI_GROUPS.map((group) => [group.id, []]));
  for (const entry of entries) {
    if (!byGroup.has(entry?.group) || !entry.unicode) continue;
    byGroup.get(entry.group).push({ emoji: canonicalEmoji(entry.unicode), label: entry.label ?? '', order: entry.order ?? 0, tags: entry.tags ?? [] });
  }
  return EMOJI_GROUPS.map((group) => ({ ...group, emoji: byGroup.get(group.id).sort((left, right) => left.order - right.order) }));
}

let catalog = null;
/** The full catalogue, loaded once, the first time a picker opens (a separate download). */
export function loadEmojiCatalog() {
  catalog ??= import('emojibase-data/en/compact.json')
    .then((module) => buildEmojiCatalog(module.default ?? module))
    .catch((error) => {
      catalog = null;
      throw error;
    });
  return catalog;
}

/** Emoji whose name or keywords start with each word typed, best matches first. */
export function searchEmoji(groups = [], query = '', limit = 80) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const results = [];
  for (const group of groups) {
    for (const entry of group.emoji) {
      const label = entry.label.toLowerCase();
      const terms = [...label.split(/[\s:,-]+/), ...entry.tags.map((tag) => tag.toLowerCase())];
      if (!words.every((word) => terms.some((term) => term.startsWith(word)))) continue;
      // A name that starts with the query beats a keyword match.
      results.push({ entry, rank: label.startsWith(words.join(' ')) ? 0 : 1 });
    }
  }
  return results.sort((left, right) => left.rank - right.rank).slice(0, limit).map((result) => result.entry);
}

/** "You, Olu Other and 2 others": who reacted with one emoji. The server marks the viewer (isViewer). */
export function whoReacted(reaction) {
  const people = reaction?.people ?? [];
  const others = people.filter((person) => !person.isViewer).map((person) => person.name);
  const shown = reaction?.mine ? ['You', ...others] : others;
  const listed = shown.slice(0, 3);
  const more = Math.max(0, (reaction?.count ?? shown.length) - listed.length);
  if (more) return `${listed.join(', ')} and ${more} other${more === 1 ? '' : 's'}`;
  if (listed.length <= 1) return listed.join('');
  return `${listed.slice(0, -1).join(', ')} and ${listed.at(-1)}`;
}

/** What a screen reader hears for a reaction button. */
export function reactionButtonLabel(reaction) {
  const people = reaction.count === 1 ? '1 person' : `${reaction.count} people`;
  return `${reaction.emoji} ${people}: ${whoReacted(reaction)}. ${reaction.mine ? 'Remove your reaction' : 'Add yours'}`;
}

/** The post (or reply) with this id given new reactions. */
export function withReactions(posts = [], postId, reactions = []) {
  return posts.map((post) => {
    if (post.id === postId) return { ...post, reactions };
    if (!post.replies?.some((reply) => reply.id === postId)) return post;
    return { ...post, replies: post.replies.map((reply) => (reply.id === postId ? { ...reply, reactions } : reply)) };
  });
}

/** The viewer's toggle applied at once, before the server answers. */
export function toggledReactions(reactions = [], emoji, reacted, viewer = { id: '', name: 'You' }) {
  const found = reactions.find((reaction) => reaction.emoji === emoji);
  if (reacted) {
    if (found?.mine) return reactions;
    if (found) return reactions.map((reaction) => (reaction.emoji === emoji ? { ...reaction, count: reaction.count + 1, mine: true, people: [...reaction.people, { ...viewer, isViewer: true }] } : reaction));
    return [...reactions, { count: 1, emoji, mine: true, people: [{ ...viewer, isViewer: true }] }];
  }
  if (!found?.mine) return reactions;
  if (found.count <= 1) return reactions.filter((reaction) => reaction.emoji !== emoji);
  return reactions.map((reaction) => (reaction.emoji === emoji ? { ...reaction, count: reaction.count - 1, mine: false, people: reaction.people.filter((person) => !person.isViewer) } : reaction));
}

/** Plain text of a post body, for a one-line quote: Markdown and tag syntax gone, tags as @Name. */
export function quoteText(body = '', max = 100) {
  const text = String(body ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/@\[([^\]]+)\]\([a-z]+:[^)]+\)/gi, '@$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The quote shown above a reply that answers another reply in its thread: { id, author, text,
 * deleted }, or { missing: true } when that reply is not loaded. Null for any other reply.
 */
export function quoteFor(reply, thread = []) {
  if (!reply?.replyToId) return null;
  const quoted = thread.find((entry) => entry.id === reply.replyToId);
  if (!quoted) return { id: reply.replyToId, missing: true };
  if (quoted.deleted) return { deleted: true, id: quoted.id };
  return { author: quoted.author?.name || 'Former member', id: quoted.id, text: quoteText(quoted.body) || (quoted.attachments?.length ? 'Attachment' : '') };
}
