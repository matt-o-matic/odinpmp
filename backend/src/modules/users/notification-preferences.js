// Email notification preferences, stored in the user's `user_preferences` JSON. Every sender
// that mails an Odin user about their own work asks here before queueing.

export const EMAIL_NOTIFICATION_PREFERENCE_KEYS = Object.freeze({
  // Something needs the user's attention: goal escalations, workspace access requests,
  // stakeholder link requests.
  attention: 'emailNotifTasks',
  // The rolled-up chat email (modules/notifications/chat-digest.service.js). It keeps the key
  // the daily channel digest it replaced used, so a member who turned that off stays off.
  chatDigest: 'emailNotifChannelDigest',
  mentions: 'emailNotifMentions',
  // Scheduled report deliveries.
  summaries: 'emailNotifSummaries',
  // New comments on requirements topics the user owns or commented on, in the mention digest.
  topicReplies: 'emailNotifTopicReplies',
});

// The profile form saved every toggle unchecked long before any sender read them, so stored
// values only count once the current form has saved them with this marker.
export const NOTIFICATION_PREFERENCES_VERSION = 1;

function preferenceKey(kind) {
  const key = EMAIL_NOTIFICATION_PREFERENCE_KEYS[kind];
  if (!key) throw new TypeError(`Unknown email notification kind: ${kind}.`);
  return key;
}

export function allowsEmailNotification(preferences, kind) {
  const key = preferenceKey(kind);
  if (!(Number(preferences?.notificationPrefsVersion) >= NOTIFICATION_PREFERENCES_VERSION)) return true;
  return preferences[key] !== false;
}

function parsePreferences(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeQuery({ emails = [], userIds = [] } = {}) {
  return {
    emails: [...new Set(emails.map((email) => String(email ?? '').trim().toLowerCase()).filter(Boolean))],
    userIds: [...new Set(userIds.map((id) => String(id ?? '').trim()).filter(Boolean))],
  };
}

/** Preferences for the users matching any of the ids or emails: `[{ email, id, preferences }]`. */
export function readUserPreferencesMemory(users, query) {
  const { emails, userIds } = normalizeQuery(query);
  return (users ?? [])
    .filter((user) => userIds.includes(user.id) || emails.includes(String(user.email ?? '').toLowerCase()))
    .map((user) => ({ email: String(user.email ?? '').toLowerCase(), id: user.id, preferences: { ...(user.preferences ?? {}) } }));
}

/** One query for every recipient, however many there are. */
export async function readUserPreferencesMysql(executor, query) {
  const { emails, userIds } = normalizeQuery(query);
  if (!emails.length && !userIds.length) return [];
  const clauses = [];
  if (userIds.length) clauses.push(`u.id IN (${userIds.map(() => '?').join(', ')})`);
  if (emails.length) clauses.push(`LOWER(u.email) IN (${emails.map(() => '?').join(', ')})`);
  const [rows] = await executor.execute(
    `
      SELECT u.id, u.email, p.value AS preferences
      FROM users u
      LEFT JOIN preferences p
        ON p.user_id = u.id
        AND p.tenant_id IS NULL
        AND p.project_id IS NULL
        AND p.\`key\` = 'user_preferences'
      WHERE ${clauses.join(' OR ')}
    `,
    [...userIds, ...emails],
  );
  return rows.map((row) => ({ email: String(row.email ?? '').toLowerCase(), id: row.id, preferences: parsePreferences(row.preferences) }));
}

/**
 * The ids and lowercased emails, among those asked about, of users who turned this kind of
 * email off. Addresses that belong to no user are never in the set. Without a reader nothing
 * is filtered, which keeps the long-standing behavior of sending.
 */
export async function findEmailOptOuts({ emails = [], kind, read, userIds = [] }) {
  preferenceKey(kind);
  const optedOut = new Set();
  if (typeof read !== 'function') return optedOut;
  for (const row of await read({ emails, userIds })) {
    if (allowsEmailNotification(row.preferences, kind)) continue;
    optedOut.add(row.id);
    if (row.email) optedOut.add(row.email);
  }
  return optedOut;
}

export function isOptedOut(optOuts, { email = '', userId = '' } = {}) {
  return optOuts.has(String(userId ?? '')) || optOuts.has(String(email ?? '').trim().toLowerCase());
}
