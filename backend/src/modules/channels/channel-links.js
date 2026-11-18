// Where a channel, a post or a channel file opens in the app. Engagements open under
// /engagements, every other project under /projects; both read ?channel, ?post and ?tab=files
// with ?file (frontend ChannelsWorkspace.vue). Paths are relative to the app's base: search
// results are routed inside the app, emails prefix the app's address (appUrl).
import { PROJECT_KIND_ENGAGEMENT } from '../../lib/projects/project-kind.js';

export function channelPath({ channelId, fileId = null, kind, postId = null, projectId }) {
  const root = kind === PROJECT_KIND_ENGAGEMENT ? `/engagements/${encodeURIComponent(projectId)}/channels` : `/projects/${encodeURIComponent(projectId)}/channels`;
  const query = new URLSearchParams({ channel: channelId });
  if (fileId) {
    query.set('tab', 'files');
    query.set('file', fileId);
  }
  if (postId) query.set('post', postId);
  return `${root}?${query}`;
}

/** The app's address without a trailing slash, or /app when none is configured. */
export function appBaseUrl(frontendAppUrl) {
  const base = String(frontendAppUrl ?? '').trim().replace(/\/$/, '');
  return base || '/app';
}

export function appUrl(frontendAppUrl, path) {
  return `${appBaseUrl(frontendAppUrl)}${path}`;
}

/**
 * Where a guest opens a channel or a post: the guest view's channel page
 * (frontend router `guest-channel`), which shows only their channels and asks them to sign in.
 */
export function guestChannelPath({ channelId, postId = null }) {
  const query = postId ? `?${new URLSearchParams({ post: postId })}` : '';
  return `/guest/channels/${encodeURIComponent(channelId)}${query}`;
}
