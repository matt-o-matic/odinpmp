// Formatting and link helpers shared by the Insights cards.

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC', year: 'numeric' });

export const HEALTH_LABELS = Object.freeze({ behind: 'At risk', 'on-track': 'On track', watch: 'Watch' });
export const HEALTH_ICONS = Object.freeze({ behind: 'bi-exclamation-triangle-fill', 'on-track': 'bi-check-circle-fill', watch: 'bi-exclamation-circle-fill' });

export function dayValue(value) {
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/** "Oct 9"; with `withYear`, "Oct 9, 2026". */
export function formatDay(value, { withYear = false } = {}) {
  const day = dayValue(value);
  if (!day) return '';
  return (withYear ? DAY_YEAR_FORMAT : DAY_FORMAT).format(new Date(`${day}T00:00:00.000Z`));
}

export function formatDateTime(value) {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Whole numbers stay whole; others keep one decimal. Thousands compact on axes. */
export function formatNumber(value, { compact = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (compact && Math.abs(number) >= 1000) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, notation: 'compact' }).format(number);
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: Number.isInteger(number) ? 0 : 1 }).format(number);
}

export function formatMoney(value, currency = 'USD', { compact = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { currency, maximumFractionDigits: compact ? 1 : 0, notation: compact ? 'compact' : 'standard', style: 'currency' }).format(number);
  } catch {
    return `${formatNumber(number, { compact })} ${currency}`;
  }
}

export function unitLabel(unit, count = 2) {
  if (unit === 'items') return count === 1 ? 'item' : 'items';
  return count === 1 ? 'pt' : 'pts';
}

export function withUnit(value, unit) {
  return `${formatNumber(value)} ${unitLabel(unit, Number(value))}`;
}

/** Router location for an evidence link target from the health signals. */
export function evidenceLocation(link, projectId) {
  if (!link) return null;
  const params = { projectId: link.projectId ?? projectId };
  switch (link.type) {
    case 'item':
      return { name: 'project-detail', params, query: { item: link.id } };
    case 'sprint':
      return { name: 'project-sprints', params };
    case 'milestone':
    case 'schedule':
    case 'baseline':
      return { name: 'project-governance', params };
    case 'burnup':
      return { hash: '#insights-card-burnup', name: 'project-insights', params };
    default:
      return null;
  }
}

/** Router location for a card's next-step action. */
export function actionLocation(target, projectId) {
  const params = { projectId };
  switch (target) {
    case 'structure':
      return { name: 'project-detail', params };
    case 'sprints':
      return { name: 'project-sprints', params };
    case 'tickets':
      return { name: 'project-tickets', params };
    case 'governance':
      return { name: 'project-governance', params };
    case 'resources':
      return { name: 'resources' };
    case 'finance':
      return { name: 'finance' };
    default:
      return null;
  }
}

export function reportsLocation(projectId) {
  return { name: 'reporting', query: { projectId, tab: 'reports' } };
}

export const VISUALIZATION_LABELS = Object.freeze({ bar: 'Bar', line: 'Line', pie: 'Pie', summary: 'Summary', table: 'Table' });

export function deliveryLabel(delivery) {
  if (!delivery) return '—';
  const channel = delivery.channel === 'email' ? 'Email' : 'In app';
  const minutes = Number(delivery.intervalMinutes);
  let cadence = '';
  if (minutes === 1440) cadence = 'daily';
  else if (minutes === 10080) cadence = 'weekly';
  else if (minutes % 60 === 0 && minutes > 0) cadence = `every ${minutes / 60}h`;
  else if (minutes > 0) cadence = `every ${minutes} min`;
  return [channel, cadence, delivery.enabled ? '' : 'paused'].filter(Boolean).join(' · ');
}
