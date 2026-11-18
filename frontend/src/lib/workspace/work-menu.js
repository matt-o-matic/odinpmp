// The top bar's Work menu (App.vue): one column each for projects, engagements and tickets, and
// in each the main page, a "New" link and the few most recent.

export const WORK_MENU_RECENT = 6;

/** Open engagements, the most recently active first. */
export function menuEngagements(engagements = [], limit = WORK_MENU_RECENT) {
  return (Array.isArray(engagements) ? engagements : [])
    .filter((engagement) => (engagement.status ?? 'open') === 'open' && engagement.kind !== 'delivery')
    .sort((left, right) => String(right.lastActivityAt ?? '').localeCompare(String(left.lastActivityAt ?? '')) || String(left.name).localeCompare(String(right.name)))
    .slice(0, limit);
}

/** Tickets as the API lists them (the most recently changed first), up to `limit`. */
export function menuTickets(tickets = [], limit = WORK_MENU_RECENT) {
  return (Array.isArray(tickets) ? tickets : []).filter((ticket) => ticket?.id && ticket.projectId).slice(0, limit);
}

/** Where a ticket in the menu opens: the Tickets page with that ticket's detail. */
export function ticketMenuLocation(ticket) {
  return { name: 'tickets', query: { project: ticket.projectId, ticket: ticket.id } };
}

/** What a "?new=" query asks the page to open, with the query left without it. */
export function takeNewQuery(query = {}, kind) {
  if (query.new !== kind) return { open: false, query };
  const rest = { ...query };
  delete rest.new;
  return { open: true, query: rest };
}
