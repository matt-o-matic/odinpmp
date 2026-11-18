// Stakeholder link display: status chip, validity text, and extension defaults.

import { formatShortDate, toDateInputValue } from './requirements-time.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const LINK_EXTENSION_MAX_DAYS = 365;
export const LINK_EXTENSION_DEFAULT_DAYS = 14;

export function linkStatusChip(link = {}) {
  if (link.status === 'revoked') return { label: 'Revoked', tone: 'bad' };
  if (link.status === 'expired') return { label: 'Expired', tone: 'outline' };
  return { label: 'Active', tone: 'ok' };
}

/** How long the link lasts, in words. */
export function linkValidityText(link = {}, { locale } = {}) {
  if (link.status === 'revoked') return link.revokedAt ? `Revoked ${formatShortDate(link.revokedAt, { locale })}` : 'Revoked';
  if (link.involvementActive) {
    return link.extendedUntil
      ? `While involved, at least until ${formatShortDate(link.extendedUntil, { locale })}`
      : 'While involved, then 14 days';
  }
  if (!link.expiresAt) return '';
  const date = formatShortDate(link.expiresAt, { locale });
  return link.status === 'expired' ? `Expired ${date}` : `Until ${date}`;
}

export function linkLastUsedText(link = {}, { locale } = {}) {
  return link.lastUsedAt ? `Last used ${formatShortDate(link.lastUsedAt, { locale })}` : 'Not used yet';
}

export function canExtendLink(link = {}) {
  return link.status !== 'revoked';
}

export function canRevokeLink(link = {}) {
  return link.status !== 'revoked';
}

/** Date-input bounds and default for extending a link: tomorrow to a year out. */
export function linkExtensionBounds(link = {}, { now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const base = Math.max(current.valueOf(), Date.parse(link.expiresAt ?? '') || 0);
  return {
    defaultValue: toDateInputValue(new Date(base + (LINK_EXTENSION_DEFAULT_DAYS * DAY_MS))),
    max: toDateInputValue(new Date(current.valueOf() + ((LINK_EXTENSION_MAX_DAYS - 1) * DAY_MS))),
    min: toDateInputValue(new Date(current.valueOf() + DAY_MS)),
  };
}

/** Project stakeholders who could get a link, with their current link if any. */
export function stakeholderLinkOptions(stakeholders = [], links = []) {
  const linkByStakeholder = new Map((links ?? []).map((link) => [link.stakeholder?.id, link]));
  return (stakeholders ?? [])
    .filter((stakeholder) => stakeholder?.id)
    .map((stakeholder) => ({
      email: stakeholder.email ?? '',
      id: stakeholder.id,
      link: linkByStakeholder.get(stakeholder.id) ?? null,
      name: stakeholder.name || stakeholder.email || 'Stakeholder',
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}
