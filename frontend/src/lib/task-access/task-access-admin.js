// The manager's side of task access: the Off / Their work / Everyone's work setting on a
// project's Resources tab, the access link's state, and the profile email's errors.

import { formatAgo } from '../requirements/requirements-time.js';
import { requirementsErrorCode } from '../requirements/requirements-errors.js';

export const TASK_ACCESS_OPTIONS = Object.freeze([
  { label: 'Off', value: 'off' },
  { label: 'Their work: see and update what’s assigned to them', value: 'own' },
  { label: 'Everyone’s work: see all work, update their own', value: 'all' },
]);

/** The grant's scope, with no grant (or a turned-off one) as `off`. */
export function taskAccessScope(entry) {
  return entry?.scope === 'own' || entry?.scope === 'all' ? entry.scope : 'off';
}

export function taskAccessLabel(scope) {
  if (scope === 'own') return 'Their work';
  if (scope === 'all') return 'Everyone’s work';
  return 'Off';
}

function shortDate(value, { locale } = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date);
}

/** "Link active · opened 2 days ago", "Link active until Nov 12 · not opened yet", "Link turned off". */
export function accessLinkStateText(link, { locale, now = new Date() } = {}) {
  if (!link) return 'No link sent yet';
  if (link.status === 'revoked') return 'Link turned off';
  if (link.status === 'expired') {
    const ended = shortDate(link.expiresAt, { locale });
    return ended ? `Link expired ${ended}` : 'Link expired';
  }
  const until = shortDate(link.expiresAt, { locale });
  const used = link.lastUsedAt ? `opened ${formatAgo(link.lastUsedAt, { locale, now })}` : 'not opened yet';
  return `${until ? `Link active until ${until}` : 'Link active'} · ${used}`;
}

/** Why a link can't be sent yet: `no-email`, `off`, or '' when it can. */
export function linkSendBlocker(entry) {
  if (!entry?.email) return 'no-email';
  if (taskAccessScope(entry) === 'off') return 'off';
  return '';
}

/** "Turn off link" applies to a link that exists and isn't already turned off. */
export function canTurnOffLink(link) {
  return Boolean(link) && link.status !== 'revoked';
}

// Why the server won't turn task access on or send the link, in the manager's words.
const TASK_ACCESS_MESSAGES = Object.freeze({
  resource_has_login: 'They have an Odin login, so they sign in instead of using a link.',
  resource_inactive: 'Their profile is inactive. Make it active on Resources first.',
  resource_needs_email: 'Add an email to their profile first.',
  resource_not_on_project: 'They’re no longer allocated to this project.',
  task_access_off: 'Task access is off for them on this project. Turn it on before sending a link.',
});

/** A task access or link error in plain words; `known` says the server named the reason. */
export function taskAccessErrorMessage(error, fallback = 'That didn’t save. Try again.') {
  const message = TASK_ACCESS_MESSAGES[requirementsErrorCode(error)];
  return message ? { known: true, message } : { known: false, message: error?.message || fallback };
}

export function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
}

/** A resource profile save error in plain words, including the email refusals. */
export function resourceProfileErrorMessage(error, fallback = 'Unable to save the resource.') {
  const code = requirementsErrorCode(error);
  if (code === 'email_has_login') return 'That email belongs to a member of this workspace. They sign in to Odin, so choose their login under Odin login instead.';
  if (code === 'email_in_use') return 'Another profile without a login already uses that email. Each email can be on one profile.';
  return error?.message || fallback;
}
