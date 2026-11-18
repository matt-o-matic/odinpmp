import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { appUrl } from '../channels/channel-links.js';
import { mentionExcerpt } from '../requirements/mentions/mention-tokens.js';
import { createChannelGuestDirectory } from './guest-directory.js';
import { effectiveNotificationLevel, isNotificationLevel, postRecipients } from './notification-levels.js';
import { publishNotificationCreated, publishNotificationsRead } from './notification-events.js';

// Notifications: who a post, a reply or an assignment notifies, the records it writes, and
// how they are shown.
//
// - One notification per person per event, never for the person's own actions. Posts in a
//   channel at level `all` collapse into one notification per channel until it is read.
// - Each new or changed notification goes out on the person's live stream and, unless they have
//   Odin focused, as a Web Push.
// - A notification still unread `unseenDelayMs` after it was made joins the person's rolled-up
//   email (chat-digest.service.js).
// - Members are principal type 'user'. Guests are 'stakeholder', and only hear about channels
//   they are in; their links open the guest view (guest-directory.js).
//
// Recording never fails the write that caused it: errors are logged and the post stands.

export const UNSEEN_DELAY_MS = 10 * 60_000;
export const NOTIFICATIONS_PAGE_SIZE = 50;
export const NOTIFICATION_RETENTION_DAYS = 90;
const EXCERPT_RADIUS = 80;
// The longest preview of a post, and of the first post of the thread a reply is in.
const PREVIEW_MAX = 200;
const THREAD_PREVIEW_MAX = 100;
const DAY_MS = 86_400_000;

function shorten(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A post's text in short, for the bell, push and email. A poll adds its question, so the reader
 * knows it is a poll: "Poll: Lunch on Friday?", or "Team lunch · Poll: Lunch on Friday?" when
 * the author wrote text above it. `actorRef` centres the text on that person's mention.
 */
function postPreview(body, poll = null, { actorRef = '', max = PREVIEW_MAX } = {}) {
  const text = mentionExcerpt(body ?? '', actorRef, { radius: EXCERPT_RADIUS });
  if (!poll?.question) return shorten(text, max);
  const question = `Poll: ${poll.question}`;
  // A poll posted with nothing above it has its question as its text (polls.service.js pollBody).
  const onlyQuestion = !text || text === mentionExcerpt(poll.question, '', { radius: EXCERPT_RADIUS });
  return shorten(onlyQuestion ? question : `${text} · ${question}`, max);
}

/** Deletes notifications with no activity for `days`, and focus heartbeats that ran out (job:clean-sessions). */
export async function purgeOldNotifications(repository, { days = NOTIFICATION_RETENTION_DAYS, now = new Date() } = {}) {
  return repository.purgeNotifications({ before: new Date(now.getTime() - days * DAY_MS), now });
}

export function memberPrincipal(user) {
  const tenantId = user?.memberships?.[0]?.tenantId ?? null;
  return tenantId && user?.id ? { principalId: String(user.id), principalType: 'user', tenantId } : null;
}

const refOf = (person) => `${person.actorType}:${person.actorId}`;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The heading and short text a notification shows, from what it recorded. Every project has a
 * #General, so push and email name the project too: "#General (Contoso pursuit)". The bell groups
 * by project and passes `withProject: false`. `thread` is the preview of the first post of the
 * thread a reply is in, so two emails about one thread show it; empty for a thread's first post.
 */
export function describeNotification(notification, { withProject = true } = {}) {
  return { thread: notification.summary?.threadExcerpt ?? '', ...describeHeading(notification, { withProject }) };
}

function describeHeading(notification, { withProject }) {
  const summary = notification.summary ?? {};
  const actor = summary.actorName || 'Someone';
  const project = withProject && summary.projectName ? ` (${summary.projectName})` : '';
  const channelOrFile = summary.fileName || (summary.channelName ? `#${summary.channelName}` : '');
  const place = channelOrFile ? `${channelOrFile}${project}` : (notification.conversationId ? 'a direct message' : '');
  switch (notification.kind) {
    case 'mention':
      return { excerpt: summary.excerpt ?? '', title: `${actor} mentioned you${place ? ` in ${place}` : ''}` };
    case 'thread_reply':
      return { excerpt: summary.excerpt ?? '', title: `${actor} replied in a thread${place ? ` in ${place}` : ''}` };
    case 'odin_reply':
      return { excerpt: summary.excerpt ?? '', title: `Odin replied to your post${place ? ` in ${place}` : ''}` };
    case 'channel_post':
      return notification.collapseCount > 1
        ? { excerpt: `${actor}: ${summary.excerpt ?? ''}`, title: `${plural(notification.collapseCount, 'new post')} in ${place}` }
        : { excerpt: summary.excerpt ?? '', title: `${actor} posted in ${place}` };
    case 'direct_message':
      return notification.collapseCount > 1
        ? { excerpt: `${actor}: ${summary.excerpt ?? ''}`, title: `${plural(notification.collapseCount, 'new direct message')}` }
        : { excerpt: summary.excerpt ?? '', title: `${actor} sent you a direct message` };
    case 'task_assigned':
      return { excerpt: summary.itemName ?? '', title: `${actor} assigned you ${/^[aeiou]/i.test(summary.itemType || 'task') ? 'an' : 'a'} ${summary.itemType || 'task'}${project ? ` in ${summary.projectName}` : ''}` };
    default:
      return { excerpt: summary.excerpt ?? '', title: `${actor} sent you a message` };
  }
}

/**
 * The app path a member opens a notification at. Chat items open in Odin Chat:
 * a direct message at /chat/dm/:conversationId, a channel post, reply or file comment at
 * /chat/channels/:projectId/:channelId with the post or the file. `post` is the post itself,
 * a reply too: replies show under their thread's first post, so the thread opens with the
 * reply marked. A task opens on its project, as before.
 */
export function memberNotificationPath(notification) {
  const { channelId, conversationId, fileId, itemId, kind, projectId } = notification;
  if (kind === 'task_assigned' && projectId && itemId) {
    return notification.summary?.itemType === 'ticket'
      ? `/tickets?ticket=${encodeURIComponent(itemId)}`
      : `/projects/${encodeURIComponent(projectId)}?item=${encodeURIComponent(itemId)}`;
  }
  const focus = notificationPostId(notification);
  if (conversationId) return `/chat/dm/${encodeURIComponent(conversationId)}${focus ? `?${new URLSearchParams({ post: focus })}` : ''}`;
  if (channelId && projectId) {
    const query = fileId ? new URLSearchParams({ file: fileId, tab: 'files' }) : (focus ? new URLSearchParams({ post: focus }) : null);
    return `/chat/channels/${encodeURIComponent(projectId)}/${encodeURIComponent(channelId)}${query ? `?${query}` : ''}`;
  }
  return projectId ? `/projects/${encodeURIComponent(projectId)}` : '/';
}

/** The post a notification's link opens on: the post itself, or its thread when none is kept. */
function notificationPostId({ postId = null, threadId = null }) {
  return postId ?? threadId ?? null;
}

export function createNotificationsService({
  authRepository = null,
  frontendAppUrl = '',
  guestDirectory = null,
  liveEventBus = null,
  now = () => new Date(),
  projectRepository,
  pushSender = null,
  repository,
  unseenDelayMs = UNSEEN_DELAY_MS,
}) {
  const guests = guestDirectory ?? createChannelGuestDirectory({ projectRepository });

  function pathFor(principal, notification) {
    return principal.principalType === 'user' ? memberNotificationPath(notification) : guests.linkFor(notification);
  }

  // The bell's view: it shows the project once, as the group, so the title leaves it out.
  function present(principal, notification) {
    const { excerpt, title } = describeNotification(notification, { withProject: false });
    return {
      channelId: notification.channelId,
      conversationId: notification.conversationId ?? null,
      count: notification.collapseCount,
      createdAt: notification.createdAt,
      excerpt,
      id: notification.id,
      kind: notification.kind,
      path: pathFor(principal, notification),
      projectId: notification.projectId,
      projectName: notification.summary?.projectName ?? '',
      readAt: notification.readAt,
      title,
      updatedAt: notification.updatedAt,
    };
  }

  async function record(principal, fields) {
    const at = now();
    const { created, notification } = await repository.recordNotification({
      notification: { ...principal, ...fields, digestAfter: new Date(at.getTime() + unseenDelayMs) },
      now: at,
    });
    if (!notification) return null;
    publishNotificationCreated(liveEventBus, principal, notification.id);
    const { excerpt, title } = describeNotification(notification);
    pushSender?.deliver(principal, { body: excerpt, kind: notification.kind, notificationId: notification.id, tag: notification.collapseKey ?? notification.id, title, url: appUrl(frontendAppUrl, pathFor(principal, notification)) });
    return { created, notification };
  }

  // Each person's level in a channel: their stored one, or the default.
  async function levelsOf({ channelId, people, project }) {
    const stored = await repository.listChannelLevels({ channelId });
    return people.map((person) => ({
      ...person,
      level: effectiveNotificationLevel({ principalId: person.actorId, principalType: person.actorType, project, projectRole: person.projectRole ?? null, stored: stored.get(refOf(person)) }).level,
    }));
  }

  // Whose notification a recipient's is: a member's own, or for a channel guest (a stakeholder
  // on this project) the guest directory's principal for them, which the guests module keeps
  // per workspace access link. Null when the directory knows no such guest.
  async function recipientPrincipal(recipient, { projectId, tenantId }) {
    if (recipient.actorType === 'stakeholder' && guests.principalFor) return guests.principalFor({ projectId, stakeholderId: recipient.actorId, tenantId });
    return { principalId: recipient.actorId, principalType: recipient.actorType, tenantId };
  }

  async function threadPeople({ parent, tenantId }) {
    if (!parent) return [];
    const authors = await projectRepository.listThreadAuthors?.({ parentId: parent.id, tenantId }) ?? [];
    return [`${parent.authorType}:${parent.authorId}`, ...authors.map((author) => `${author.authorType}:${author.authorId}`)];
  }

  return {
    describe: present,

    /**
     * After a channel post, a reply, an edit that tags people, or a file comment. `people` are
     * those who can read the channel (channels.service.js channelPeople), with `projectRole`;
     * `mentioned` the people the body newly tags ([{ actorRef }]); `parent` the post a reply
     * answers. A file comment passes `file` and no watched-channel notifications go out.
     */
    async notifyPost({ author, channel = null, file = null, isEdit = false, mentioned = [], parent = null, people, post, projectId, tenantId }) {
      const notified = [];
      try {
        const project = await projectRepository.getProjectKind?.({ projectId }) ?? null;
        const withLevels = channel ? await levelsOf({ channelId: channel.id, people, project }) : people.map((person) => ({ ...person, level: 'mentions' }));
        const recipients = postRecipients({
          author,
          isEdit,
          mentioned: mentioned.map((entry) => entry.actorRef),
          people: withLevels,
          threadPeople: isEdit ? [] : await threadPeople({ parent, tenantId }),
          watched: !file,
        });
        const base = {
          actorId: author.id,
          actorType: author.type,
          channelId: channel?.id ?? null,
          fileId: file?.id ?? null,
          postId: post.id,
          projectId,
          tenantId,
          threadId: parent?.id ?? null,
        };
        // The polls on the post and on the thread's first post, for their previews.
        const polls = recipients.length ? await projectRepository.listPolls?.({ postIds: [post.id, parent?.id].filter(Boolean), tenantId }) ?? [] : [];
        const pollOf = (postId) => polls.find((poll) => poll.postId === postId) ?? null;
        const threadExcerpt = parent ? postPreview(parent.body, pollOf(parent.id), { max: THREAD_PREVIEW_MAX }) : '';
        for (const recipient of recipients) {
          const odinAnswer = author.type === 'odin' && recipient.reason === 'thread_reply' && parent && refOf(recipient) === `${parent.authorType}:${parent.authorId}`;
          const kind = odinAnswer ? 'odin_reply' : recipient.reason;
          const summary = {
            actorName: author.type === 'odin' ? 'Odin' : author.name || 'Someone',
            channelName: channel?.name ?? '',
            excerpt: postPreview(post.body, pollOf(post.id), { actorRef: kind === 'mention' ? refOf(recipient) : '' }),
            fileName: file?.fileName ?? '',
            projectKind: project?.kind ?? 'delivery',
            projectName: project?.name ?? '',
            threadExcerpt,
          };
          const principal = await recipientPrincipal(recipient, { projectId, tenantId });
          if (!principal) continue;
          const saved = await record(principal, {
            ...base,
            collapseKey: kind === 'channel_post' ? `channel:${channel.id}` : null,
            kind,
            summary,
          });
          if (saved) notified.push({ actorRef: refOf(recipient), kind });
        }
      } catch (error) {
        logBackendError({ context: buildOperationLogContext('notifications.notifyPost', { projectId, tenantId }), error, level: 'warn', message: 'Notifications for a post could not be recorded; the post was saved.' });
      }
      return notified;
    },

    /**
     * After a direct message post, reply or edit (chat/direct-messages.service.js). Every other
     * member of the conversation hears of a new post as direct_message, whatever their channel
     * levels: one open notification per conversation that collapses until it is read. A member
     * the post tags gets a mention instead; an edit notifies only those it newly tags.
     */
    async notifyDirectMessage({ author, conversation, isEdit = false, mentioned = [], post, tenantId }) {
      const notified = [];
      try {
        const tagged = new Set(mentioned.map((entry) => entry.actorRef));
        for (const member of conversation.members ?? []) {
          const ref = `user:${member.userId}`;
          if (String(member.userId) === String(author.id)) continue;
          const kind = tagged.has(ref) ? 'mention' : 'direct_message';
          if (isEdit && kind !== 'mention') continue;
          const saved = await record({ principalId: String(member.userId), principalType: 'user', tenantId }, {
            actorId: author.id,
            actorType: 'user',
            collapseKey: kind === 'direct_message' ? `dm:${conversation.id}` : null,
            conversationId: conversation.id,
            kind,
            postId: post.id,
            summary: {
              actorName: author.name || 'Someone',
              excerpt: mentionExcerpt(post.body ?? '', kind === 'mention' ? ref : '', { radius: EXCERPT_RADIUS }),
              projectKind: 'direct',
              projectName: '',
            },
            threadId: post.parentId ?? null,
          });
          if (saved) notified.push({ actorRef: ref, kind });
        }
      } catch (error) {
        logBackendError({ context: buildOperationLogContext('notifications.notifyDirectMessage', { tenantId }), error, level: 'warn', message: 'Notifications for a direct message could not be recorded; the message was saved.' });
      }
      return notified;
    },

    /** A work item revision that gave the item a new assignee: tells that member. */
    async notifyItemRevision(revision) {
      try {
        const to = revision?.after?.node?.assigneeId ?? null;
        const from = revision?.before?.node?.assigneeId ?? null;
        if (!to || to === from || String(to).includes(':') || String(to) === String(revision.actorUserId)) return null;
        const assignee = await authRepository?.findUserById?.(String(to));
        if (!assignee?.memberships?.some((membership) => membership.tenantId === revision.tenantId)) return null;
        const actor = revision.actorUserId ? await authRepository.findUserById(String(revision.actorUserId)) : null;
        const project = await projectRepository.getProjectKind?.({ projectId: revision.projectId }) ?? null;
        return await record({ principalId: String(to), principalType: 'user', tenantId: revision.tenantId }, {
          actorId: String(revision.actorUserId ?? ''),
          actorType: 'user',
          itemId: revision.itemId,
          kind: 'task_assigned',
          projectId: revision.projectId,
          summary: { actorName: actor?.name ?? 'Someone', itemName: revision.after.node.name ?? '', itemType: revision.itemType ?? 'task', projectKind: project?.kind ?? 'delivery', projectName: project?.name ?? '' },
        });
      } catch (error) {
        logBackendError({ context: buildOperationLogContext('notifications.notifyItemRevision', { projectId: revision?.projectId ?? null }), error, level: 'warn', message: 'An assignment notification could not be recorded.' });
        return null;
      }
    },

    async list(principal, { limit = NOTIFICATIONS_PAGE_SIZE } = {}) {
      const notifications = await repository.listNotifications({ ...principal, limit });
      return { notifications: notifications.map((entry) => present(principal, entry)), unreadCount: await repository.countUnread(principal) };
    },

    async get(principal, id) {
      const notification = await repository.getNotification({ ...principal, id });
      return notification ? present(principal, notification) : null;
    },

    /** Marks read by ids, by channel (opening it), or all; tells the person's other tabs. */
    async markRead(principal, { all = false, channelId = null, conversationId = null, ids = null } = {}) {
      const marked = await repository.markNotificationsRead({ ...principal, all, channelId, conversationId, ids, now: now() });
      if (all) publishNotificationsRead(liveEventBus, principal, { all: true });
      else publishNotificationsRead(liveEventBus, principal, { ids: marked });
      return { marked, unreadCount: await repository.countUnread(principal) };
    },

    /** Each channel's level for a person in one project: Map channelId -> { level, isDefault }. */
    async channelLevels(principal, { channelIds, project, projectRole }) {
      const stored = await repository.getChannelLevels({ ...principal, channelIds });
      return new Map(channelIds.map((channelId) => [channelId, effectiveNotificationLevel({ ...principal, project, projectRole, stored: stored.get(channelId) })]));
    },

    /** Stores a level, or with `level: null` goes back to the default. */
    async setChannelLevel(principal, { channelId, level }) {
      if (level !== null && !isNotificationLevel(level)) throw new TypeError(`Unknown notification level ${level}.`);
      await repository.setChannelLevel({ ...principal, channelId, level, now: now() });
    },

    purgeOld: ({ days = NOTIFICATION_RETENTION_DAYS } = {}) => purgeOldNotifications(repository, { days, now: now() }),

    pathFor,
  };
}
