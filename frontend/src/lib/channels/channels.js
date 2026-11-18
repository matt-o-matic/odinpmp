// Channel screens' helpers (docs/engagements/plan.md, Channels and conversation, Files). Pure
// functions, so they test without a browser.
import { createLiveUpdates } from '../live/live-updates.js';

export const CHANNEL_UPDATED_EVENT = 'channel.updated';
export const CHANNEL_TABS = Object.freeze([
  { id: 'conversation', label: 'Conversation' },
  { id: 'files', label: 'Files' },
]);

export function normalizeChannelTab(value) {
  return CHANNEL_TABS.some((tab) => tab.id === value) ? value : 'conversation';
}

/** The channel a link names: its id, or "general" for the project's General channel. */
export function pickChannel(channels = [], wanted = '') {
  const value = String(wanted ?? '').trim();
  if (value && value.toLowerCase() !== 'general') {
    const found = channels.find((channel) => channel.id === value);
    if (found) return found;
  }
  return channels.find((channel) => channel.isGeneral) ?? channels[0] ?? null;
}

/** "3", or "99+" past 99. Empty for none. */
export function unreadLabel(count) {
  const value = Number(count ?? 0);
  if (!(value > 0)) return '';
  return value > 99 ? '99+' : String(value);
}

/** "10:42" today, "Yesterday 10:42", then "12 Nov, 10:42". */
export function postTimeLabel(value, now = new Date()) {
  const at = new Date(value ?? '');
  if (Number.isNaN(at.valueOf())) return '';
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const dayStart = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).valueOf();
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}, ${time}`;
}

/**
 * Puts a post the server returned into the newest-first list: a new top-level post at the front,
 * a reply into its parent, or an edited or deleted one in its place. A post already there is
 * replaced, never added twice.
 */
export function upsertPost(posts = [], post) {
  if (!post) return posts;
  if (post.parentId) {
    return posts.map((entry) => {
      if (entry.id !== post.parentId) return entry;
      const replies = entry.replies ?? [];
      const known = replies.some((reply) => reply.id === post.id);
      return { ...entry, replies: known ? replies.map((reply) => (reply.id === post.id ? post : reply)) : [...replies, post] };
    });
  }
  if (posts.some((entry) => entry.id === post.id)) return posts.map((entry) => (entry.id === post.id ? { ...post, replies: post.replies?.length ? post.replies : entry.replies ?? [] } : entry));
  return [post, ...posts];
}

/** Whether Odin is working on a tag in this thread: its first post or any reply. */
export function threadOdinReplying(post) {
  return [post, ...(post?.replies ?? [])].some((entry) => entry?.odin?.status === 'replying');
}

const CONFIRMATION_NOTES = {
  approved: 'Confirmed.',
  declined: 'Cancelled.',
  expired: 'This is no longer waiting.',
  pending: 'Waiting for the person who tagged Odin to confirm.',
  skipped: 'This is no longer waiting.',
};

/** What an Odin reply's confirmation says to someone without the buttons, or after the answer. */
export function odinConfirmationNote(confirmation) {
  return CONFIRMATION_NOTES[confirmation?.status] ?? CONFIRMATION_NOTES.expired;
}

/** Older pages join at the end of the newest-first list, without repeats. */
export function appendOlder(posts = [], older = []) {
  const known = new Set(posts.map((post) => post.id));
  return [...posts, ...older.filter((post) => !known.has(post.id))];
}

/** Whether the loaded posts hold `postId`: a thread's first post or one of its replies. */
export function hasPost(posts = [], postId = '') {
  if (!postId) return false;
  return posts.some((post) => post.id === postId || (post.replies ?? []).some((reply) => reply.id === postId));
}

/**
 * The tag a reply starts with: the author of the message it answers, as { label, ref }. Only
 * someone in `people` (whom the writer may tag; never the writer) gets one, so nobody is tagged
 * for replying to their own message, to a former member, or to Odin where Odin is off.
 */
export function replyTagFor(author, people = []) {
  if (!author) return null;
  const wanted = author.type === 'odin' ? 'odin:odin' : `${author.type}:${author.id}`;
  const person = (people ?? []).find((entry) => entry?.ref === wanted);
  return person ? { label: person.name || author.name || '', ref: person.ref } : null;
}

/**
 * A link to a post (?post= from an email, push or the bell) can name one older than the first
 * page. This loads earlier pages until the post is there, there are no more, or `maxPages`
 * pages were read. `fetchOlder(cursor)` returns { posts, nextCursor }, like listChannelPosts.
 */
export async function loadUntilPost({ cursor = null, fetchOlder, maxPages = 5, postId, posts = [] }) {
  let loaded = posts;
  let next = cursor;
  for (let page = 0; postId && !hasPost(loaded, postId) && next && page < maxPages; page += 1) {
    const result = await fetchOlder(next);
    loaded = appendOlder(loaded, result?.posts ?? []);
    next = result?.nextCursor ?? null;
  }
  return { found: hasPost(loaded, postId), nextCursor: next, posts: loaded };
}

/** Who is editing a file, for the marker beside it. */
export function editingLabel(editing, currentUserId = '', now = new Date()) {
  if (!editing?.userId) return '';
  const who = editing.userId === currentUserId ? 'You are' : `${editing.name || 'Someone'} is`;
  const since = postTimeLabel(editing.since, now);
  return since ? `${who} editing · since ${since}` : `${who} editing`;
}

/** The folders from the library's top level down to `folderId`. */
export function folderTrail(folders = [], folderId = null) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail = [];
  const seen = new Set();
  for (let at = folderId ? byId.get(folderId) : null; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : null) {
    seen.add(at.id);
    trail.unshift(at);
  }
  return trail;
}

export function childFolders(folders = [], parentId = null) {
  return folders
    .filter((folder) => (folder.parentId ?? null) === (parentId ?? null))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

/** Where a folder can move: the top level or any folder in its channel but itself and those inside it. */
export function folderMoveTargets(folders = [], folder) {
  if (!folder) return [];
  const inside = new Set([folder.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of folders) {
      if (entry.parentId && inside.has(entry.parentId) && !inside.has(entry.id)) {
        inside.add(entry.id);
        grew = true;
      }
    }
  }
  return folders
    .filter((entry) => !inside.has(entry.id))
    .map((entry) => ({ id: entry.id, label: folderTrail(folders, entry.id).map((step) => step.name).join(' / ') }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** A readable message for a channel API error. */
export function channelErrorMessage(error, fallback) {
  const code = error?.data?.details?.code ?? error?.details?.code;
  if (code === 'engagement_closed') return 'This engagement is marked lost. Reopen it to make changes.';
  if (code === 'channel_read_only_member' || code === 'library_read_only_member') return 'You can read here, but not post or change things.';
  if (code === 'module_disabled') return 'The Consulting module is switched off for this workspace.';
  return error?.message || fallback;
}

/**
 * Channel changes made elsewhere: batches of `channel.updated` events ({ channelId, area }) in
 * `details`. This tab's own writes are skipped. A short wait gathers a burst, and keeps a post
 * from another screen well under the 2 seconds the plan allows.
 */
export function createChannelLiveUpdates({ apiClient, debounceMs = 150, projectId, ...options }) {
  return createLiveUpdates({
    ...options,
    debounceMs,
    eventType: CHANNEL_UPDATED_EVENT,
    keepDetails: true,
    open: (token, handlers) => apiClient.subscribeToProjectEvents(projectId, token, handlers),
    ownClientId: apiClient.clientId,
  });
}
