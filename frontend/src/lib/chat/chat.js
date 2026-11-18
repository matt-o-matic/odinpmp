// Odin Chat's helpers (docs/odin-chat/plan.md, Odin Chat): where each sidebar entry opens, the
// jump-to list, the start page, and labels. Pure functions, so they test without a browser.
import { unreadLabel } from '../channels/channels.js';

export const CHAT_PHONE_QUERY = '(max-width: 767.98px)';
export const START_PAGES = Object.freeze([
  { label: 'Odin', value: 'odin' },
  { label: 'Odin Chat', value: 'chat' },
]);
export const MAX_DIRECT_OTHERS = 7;
const JUMP_LIMIT = 8;

export { unreadLabel };

/** The start page a member chose: 'chat' or the default 'odin'. */
export function startPageOf(preferences) {
  return preferences?.startPage === 'chat' ? 'chat' : 'odin';
}

// Whether the next signed-in page is the first of a visit (or of a sign-in).
let landingPending = true;

/** True once per visit or sign-in: the first signed-in page asks, the rest don't. */
export function takeLanding() {
  const pending = landingPending;
  landingPending = false;
  return pending;
}

/** Called on signing in, so the page after it lands on the start page. */
export function markLanding() {
  landingPending = true;
}

/**
 * Where a member lands when Odin opens: Odin Chat if they chose it as their start page and are
 * opening Odin's home, otherwise where they were going. Only the first page of a visit lands.
 */
export function landingRedirect({ landing, preferences, toName }) {
  if (!landing || toName !== 'home') return null;
  return startPageOf(preferences) === 'chat' ? { name: 'chat-home' } : null;
}

export function channelRoute({ channelId, projectId }, { postId = '' } = {}) {
  return { name: 'chat-channel', params: { channelId, projectId }, query: postId ? { post: postId } : {} };
}

export function directRoute(conversationId, { postId = '' } = {}) {
  return { name: 'chat-direct', params: { conversationId }, query: postId ? { post: postId } : {} };
}

/** Where a post in Mentions or Threads opens: its channel or conversation, scrolled to its thread. */
export function placeRoute(place, post) {
  const postId = post?.parentId || post?.id || '';
  if (place?.type === 'dm') return directRoute(place.conversationId, { postId });
  return channelRoute({ channelId: place.channelId, projectId: place.projectId }, { postId });
}

/** "#General · Contoso rollout", or the conversation's people. */
export function placeLabel(place) {
  if (!place) return '';
  return place.type === 'dm' ? place.title : `#${place.channelName} · ${place.projectName}`;
}

/** "Lena Lead", or "Lena Lead, Olu Other" for a group. */
export function conversationLabel(conversation) {
  return conversation?.title || conversation?.members?.map((member) => member.name).join(', ') || 'Conversation';
}

/** "2 unread", "1 mention", or both, for screen readers beside a sidebar entry. */
export function countsLabel({ mentionCount = 0, unreadCount = 0 } = {}) {
  const parts = [];
  if (unreadCount > 0) parts.push(`${unreadCount} unread`);
  if (mentionCount > 0) parts.push(`${mentionCount} ${mentionCount === 1 ? 'mention' : 'mentions'}`);
  return parts.join(', ');
}

const normalized = (value) => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();

/**
 * What the jump-to box offers for `query`: Odin, channels, direct messages and people, best
 * matches first (names that start with it, then names that contain it), at most 8. People already
 * in a one-to-one conversation open it; others start one.
 */
export function jumpTargets({ people = [], query = '', sidebar = null } = {}) {
  const wanted = normalized(query);
  if (!wanted) return [];
  const entries = [{ detail: 'AI Workspace', key: 'odin', kind: 'odin', label: 'Odin', to: { name: 'chat-odin' } }];
  for (const group of sidebar?.groups ?? []) {
    for (const channel of group.channels ?? []) {
      entries.push({ detail: group.name, key: `channel:${channel.id}`, kind: 'channel', label: `#${channel.name}`, match: channel.name, to: channelRoute({ channelId: channel.id, projectId: group.id }) });
    }
  }
  const oneToOne = new Map();
  for (const conversation of sidebar?.directMessages ?? []) {
    entries.push({ detail: conversation.isGroup ? 'Group message' : 'Direct message', key: `dm:${conversation.id}`, kind: 'dm', label: conversationLabel(conversation), to: directRoute(conversation.id) });
    if (!conversation.isGroup) {
      for (const member of conversation.members ?? []) oneToOne.set(member.id, conversation.id);
    }
  }
  for (const person of people) {
    if (oneToOne.has(person.id)) continue;
    entries.push({ detail: 'Start a conversation', key: `person:${person.id}`, kind: 'person', label: person.name, personId: person.id });
  }
  const score = (entry) => {
    const name = normalized(entry.match ?? entry.label);
    if (name.startsWith(wanted)) return 0;
    if (name.split(/[\s,#-]+/).some((word) => word.startsWith(wanted))) return 1;
    return name.includes(wanted) ? 2 : -1;
  };
  return entries
    .map((entry) => ({ entry, rank: score(entry) }))
    .filter(({ rank }) => rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.entry.label.localeCompare(right.entry.label))
    .slice(0, JUMP_LIMIT)
    .map(({ entry }) => entry);
}

/** The people a "New message" picker shows for `query`, without those already chosen. */
export function pickablePeople(people = [], { chosen = [], query = '' } = {}) {
  const wanted = normalized(query);
  const taken = new Set(chosen.map((person) => person.id));
  return people.filter((person) => !taken.has(person.id) && (!wanted || normalized(person.name).includes(wanted) || normalized(person.email).includes(wanted)));
}

/** The sections a person collapsed, read safely from storage. */
export function readCollapsed(storage, key) {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

export function writeCollapsed(storage, key, values) {
  try {
    storage?.setItem(key, JSON.stringify([...values]));
  } catch {
    // The choice just isn't remembered.
  }
}
