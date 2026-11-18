// Notification levels per channel and person.
//
// - all: every post in the channel, collapsed into one notification per channel until read.
// - mentions: being mentioned, and replies in threads the person started or replied in.
// - off: nothing from this channel.
//
// Without a stored level, the default is `all` for the engagement's owner and the project's
// admins and managers, and `mentions` for everyone else, guests included.

export const NOTIFICATION_LEVELS = Object.freeze(['all', 'mentions', 'off']);
export const PRINCIPAL_TYPES = Object.freeze(['user', 'stakeholder']);

const WATCHING_PROJECT_ROLES = new Set(['admin', 'manager']);

export function isNotificationLevel(value) {
  return NOTIFICATION_LEVELS.includes(value);
}

/**
 * The level a person has in a project's channels when they stored none. `project` carries
 * engagementOwnerId; `projectRole` is their role on the project (user_project.role).
 */
export function defaultNotificationLevel({ principalId, principalType = 'user', project = null, projectRole = null }) {
  if (principalType !== 'user') return 'mentions';
  if (project?.engagementOwnerId && String(project.engagementOwnerId) === String(principalId)) return 'all';
  return WATCHING_PROJECT_ROLES.has(String(projectRole ?? '').trim().toLowerCase()) ? 'all' : 'mentions';
}

/** The stored level, or the default with `isDefault` set; `defaultLevel` either way. */
export function effectiveNotificationLevel({ stored = null, ...defaults }) {
  const defaultLevel = defaultNotificationLevel(defaults);
  return isNotificationLevel(stored) ? { defaultLevel, isDefault: false, level: stored } : { defaultLevel, isDefault: true, level: defaultLevel };
}

/**
 * Who a post notifies, and how: one entry per person, the strongest reason winning (a mention,
 * then a reply in their thread, then a watched channel). Never the author. `people` are those
 * who can read the channel ({ actorType, actorId, level }); `mentioned` and `threadPeople` are
 * actor refs ('user:id'). File comments are not channel posts, so they pass `watched: false`.
 */
export function postRecipients({ author, isEdit = false, mentioned = [], people, threadPeople = [], watched = true }) {
  const authorRef = `${author.type}:${author.id}`;
  const mentionedRefs = new Set(mentioned);
  const threadRefs = new Set(threadPeople);
  const recipients = [];
  for (const person of people) {
    const ref = `${person.actorType}:${person.actorId}`;
    if (ref === authorRef || person.level === 'off') continue;
    if (mentionedRefs.has(ref)) recipients.push({ ...person, reason: 'mention' });
    else if (isEdit) continue;
    else if (threadRefs.has(ref)) recipients.push({ ...person, reason: 'thread_reply' });
    else if (watched && person.level === 'all') recipients.push({ ...person, reason: 'channel_post' });
  }
  return recipients;
}
