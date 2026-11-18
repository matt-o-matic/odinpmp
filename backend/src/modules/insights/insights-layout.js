// The Insights dashboard layout: an ordered list of cards. Built-in cards appear at most once;
// a saved report can be added as a card that runs on its own. A project with no stored layout
// shows DEFAULT_INSIGHTS_CARDS.

import { getTenantMembership } from '../../lib/auth/project-capabilities.js';

export const BUILT_IN_CARD_TYPES = Object.freeze([
  'gantt',
  'headline',
  'burnup',
  'sprint-burndown',
  'velocity',
  'cumulative-flow',
  'ticket-flow',
  'tickets-by-severity',
  'milestones',
  'earned-value',
  'throughput',
  'saved-reports',
]);
export const REPORT_CARD_TYPE = 'report';
export const MAX_INSIGHTS_CARDS = 30;

export const DEFAULT_INSIGHTS_CARDS = Object.freeze(BUILT_IN_CARD_TYPES.map((type) => Object.freeze({ type })));

const BUILT_IN = new Set(BUILT_IN_CARD_TYPES);
const LAYOUT_EDITOR_ROLES = new Set(['admin', 'manager']);

function roleOf(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Cost and earned value follow the finance rule: tenant admins and managers. */
export function canSeeFinance(user, tenantId) {
  return LAYOUT_EDITOR_ROLES.has(roleOf(getTenantMembership(user, tenantId)?.role));
}

/** Tenant admins and managers, and the project's own admins and managers, may change the layout. */
export function canEditInsightsLayout({ projectRole, tenantId, user }) {
  return LAYOUT_EDITOR_ROLES.has(roleOf(getTenantMembership(user, tenantId)?.role)) || LAYOUT_EDITOR_ROLES.has(roleOf(projectRole));
}

export function cardKey(card) {
  return card.type === REPORT_CARD_TYPE ? `${REPORT_CARD_TYPE}:${card.reportId}` : card.type;
}

/** Drops unknown types, report cards without a report, and repeats; keeps the given order. */
export function normalizeInsightsCards(cards = []) {
  const seen = new Set();
  const result = [];
  for (const card of cards) {
    const type = String(card?.type ?? '');
    const reportId = String(card?.reportId ?? '').trim();
    if (!BUILT_IN.has(type) && !(type === REPORT_CARD_TYPE && reportId)) continue;
    const normalized = type === REPORT_CARD_TYPE ? { reportId, type } : { type };
    const key = cardKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= MAX_INSIGHTS_CARDS) break;
  }
  return result;
}

/** The layout a project shows: its stored cards, or the defaults when it has none. */
export function effectiveInsightsLayout(stored) {
  if (!stored) return { cards: DEFAULT_INSIGHTS_CARDS.map((card) => ({ ...card })), isDefault: true, updatedAt: null, updatedBy: null, version: 0 };
  return { cards: normalizeInsightsCards(stored.cards), isDefault: false, updatedAt: stored.updatedAt ?? null, updatedBy: stored.updatedBy ?? null, version: Number(stored.version) || 1 };
}
