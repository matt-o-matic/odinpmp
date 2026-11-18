// The email toggles on the profile's Preferences tab. They mirror
// backend/src/modules/users/notification-preferences.js, which every sender asks.

// Saved values only count once this form has stored them with the marker; older saves kept
// every box unchecked without anyone choosing it.
export const NOTIFICATION_PREFERENCES_VERSION = 1;

export const EMAIL_NOTIFICATION_TOGGLES = Object.freeze([
  {
    help: 'Comments and descriptions where someone @mentions you.',
    id: 'emailMentions',
    key: 'emailNotifMentions',
    label: 'Someone mentions me',
  },
  {
    help: 'New comments on requirements topics you own or have commented on. They come in the same email as your mentions.',
    id: 'emailTopicReplies',
    key: 'emailNotifTopicReplies',
    label: 'Someone replies on my topics',
  },
  {
    help: 'Alerts from goals you own, requests to join a workspace you administer, and stakeholders asking for a new requirements link.',
    id: 'emailAttention',
    key: 'emailNotifTasks',
    label: 'Something needs my attention',
  },
  {
    help: 'Report subscriptions that list your email address.',
    id: 'emailReports',
    key: 'emailNotifSummaries',
    label: 'Scheduled reports sent to me',
  },
  {
    // The key the daily channel digest used, so an earlier choice carries over.
    help: 'Notifications you have not seen in Odin within 10 minutes (mentions, replies, watched channels, tasks assigned to you), rolled into one email.',
    id: 'emailChatDigest',
    key: 'emailNotifChannelDigest',
    label: 'Chat email digest',
  },
]);

/** What Odin does today for each toggle: on unless this form saved it off. */
export function effectiveEmailNotifications(preferences = {}) {
  const honored = Number(preferences?.notificationPrefsVersion) >= NOTIFICATION_PREFERENCES_VERSION;
  return Object.fromEntries(EMAIL_NOTIFICATION_TOGGLES.map(({ key }) => [key, honored ? preferences[key] !== false : true]));
}

// Two-factor sign-in only changes through the Security pane, which needs a code; the server
// ignores the flag on a profile save, so the form doesn't send its possibly stale copy.
export function preferencesForSave(preferences = {}) {
  const { twoFactorEnabled: _twoFactorEnabled, ...editable } = preferences;
  return { ...editable, notificationPrefsVersion: NOTIFICATION_PREFERENCES_VERSION };
}
