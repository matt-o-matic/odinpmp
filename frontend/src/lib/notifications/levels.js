// Channel notification levels as people see them (backend notification-levels.js; Q-03).

export const NOTIFICATION_LEVEL_OPTIONS = Object.freeze([
  { help: 'Every post, collapsed into one notification until you read the channel.', icon: 'bi-bell-fill', label: 'All new posts', level: 'all', short: 'All posts' },
  { help: 'When someone mentions you or replies in a thread you are in.', icon: 'bi-bell', label: 'Mentions only', level: 'mentions', short: 'Mentions' },
  { help: 'Nothing from this channel, mentions included.', icon: 'bi-bell-slash', label: 'Off', level: 'off', short: 'Off' },
]);

export function levelOption(level) {
  return NOTIFICATION_LEVEL_OPTIONS.find((option) => option.level === level) ?? NOTIFICATION_LEVEL_OPTIONS[1];
}
