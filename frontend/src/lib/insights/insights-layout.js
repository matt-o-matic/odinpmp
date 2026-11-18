// The Insights card catalog and the edits the dashboard's edit mode makes to a layout. The
// backend (modules/insights/insights-layout.js) owns validation; this mirrors its card types
// and default order so the editor can show what is available.

export const REPORT_CARD_TYPE = 'report';

export const INSIGHTS_CARDS = Object.freeze({
  gantt: {
    eyebrow: 'Schedule',
    help: 'Every story on one timeline, in working days from the start of the plan. Blocking comes first: a story starts only once whatever blocks it allows (a link on an epic covers every story in it). A story in a sprint starts no earlier than its sprint. Each person works one open story at a time, so their stories line up in order of earliest start, sprint and priority, and unassigned stories go to whoever is free first. Finished stories stay at their dates. Length comes from target dates, then hours, then points (a day each); stories with no estimate share what is left of their sprint. Colour is the person; a hatch means blocked now.',
    size: 'full',
    subtitle: 'Stories placed by blocking, sprints and who is doing them',
    title: 'Project timeline',
  },
  headline: {
    help: 'Forecast finish uses delivery pace when there is enough history, otherwise the Governance critical-path forecast. Scope counts leaf work items; velocity averages the last three completed sprints.',
    size: 'full',
    title: 'Headline numbers',
  },
  burnup: {
    eyebrow: 'Delivery',
    help: 'Done against total scope over time, rebuilt from item history. The forecast projects the remaining work at a weighted weekly velocity over up to six recent weeks (later weeks count more); the shaded range is one standard deviation either side.',
    size: 'wide',
    subtitle: 'Done against total scope, projected from recent velocity',
    title: 'Burnup and forecast',
  },
  'sprint-burndown': {
    eyebrow: 'Delivery',
    help: 'Work left in the sprint on each working day, against an ideal straight line to zero. Scope changes show where work was added to or removed from the sprint.',
    size: 'narrow',
    subtitle: 'Work left each working day',
    title: 'Sprint burndown',
  },
  velocity: {
    eyebrow: 'Delivery',
    help: 'Committed counts a sprint\'s items on its first day; completed counts those done on its last. The suggested commitment is the range of the last three completed sprints.',
    size: 'narrow',
    subtitle: 'Committed against completed, recent sprints',
    title: 'Velocity',
  },
  'cumulative-flow': {
    eyebrow: 'Flow',
    help: 'Leaf work items by status over time. A widening band shows where work is waiting.',
    size: 'wide',
    subtitle: 'Work items by status over time',
    title: 'Cumulative flow',
  },
  'ticket-flow': {
    eyebrow: 'Quality',
    help: 'Tickets opened and resolved in each period. Resolved means moved to closed, rejected or deferred.',
    size: 'wide',
    subtitle: 'Tickets opened and resolved per week',
    title: 'Ticket flow',
  },
  'tickets-by-severity': {
    eyebrow: 'Quality',
    help: 'Tickets that are not closed, rejected or deferred, by severity. Median age counts from when the ticket was opened.',
    size: 'narrow',
    title: 'Open tickets by severity',
  },
  milestones: {
    eyebrow: 'Schedule',
    help: 'Each milestone\'s baseline date (or its target when there is no baseline) against its Governance forecast, in working days.',
    size: 'wide',
    title: 'Milestones against baseline',
  },
  'earned-value': {
    eyebrow: 'Cost',
    help: 'Planned value is the budget times schedule progress; earned value is the budget times percent complete; actual cost is approved spend to date. CPI, SPI and EAC match the Resources screen.',
    managersOnly: true,
    size: 'narrow',
    subtitle: 'Cumulative planned value, earned value and actual cost',
    title: 'Earned value',
  },
  throughput: {
    eyebrow: 'Team',
    help: 'Items and points each person finished in the period, using the leaderboard\'s rules: a finished item credits its assignee, or whoever marked it done when nobody is assigned.',
    size: 'half',
    subtitle: 'Finished work by person',
    title: 'Throughput by person',
  },
  'saved-reports': {
    eyebrow: 'Reports',
    help: 'Reports saved for this project, and tenant reports you can see. Add one as a card to show its results here; cards run on their own.',
    size: 'full',
    title: 'Saved reports for this project',
  },
});

export const DEFAULT_INSIGHTS_CARDS = Object.freeze(Object.keys(INSIGHTS_CARDS).map((type) => Object.freeze({ type })));

export function cardKey(card) {
  return card?.type === REPORT_CARD_TYPE ? `${REPORT_CARD_TYPE}:${card.reportId}` : String(card?.type ?? '');
}

export function cardDefinition(card) {
  return INSIGHTS_CARDS[card?.type] ?? null;
}

export function cloneCards(cards = []) {
  return cards.map((card) => (card.type === REPORT_CARD_TYPE ? { reportId: card.reportId, type: REPORT_CARD_TYPE } : { type: card.type }));
}

export function sameCards(left = [], right = []) {
  return left.length === right.length && left.every((card, index) => cardKey(card) === cardKey(right[index]));
}

export function isDefaultLayout(cards = []) {
  return sameCards(cards, DEFAULT_INSIGHTS_CARDS);
}

/** Moves the card at `index` by `offset` places, staying inside the list. */
export function moveCard(cards, index, offset) {
  const target = index + offset;
  if (index < 0 || index >= cards.length || target < 0 || target >= cards.length) return cards;
  const next = [...cards];
  const [card] = next.splice(index, 1);
  next.splice(target, 0, card);
  return next;
}

export function removeCard(cards, index) {
  return cards.filter((_, position) => position !== index);
}

/** Appends a card unless the layout already shows it. */
export function addCard(cards, card) {
  return cards.some((entry) => cardKey(entry) === cardKey(card)) ? cards : [...cards, card];
}

/**
 * What edit mode can add: built-in cards not on the dashboard (cost only for people who can
 * see it), then saved reports not already shown.
 */
export function addableCards(cards, { canSeeFinance = false, reports = [] } = {}) {
  const shown = new Set(cards.map(cardKey));
  const builtIn = Object.entries(INSIGHTS_CARDS)
    .filter(([type, definition]) => !shown.has(type) && (canSeeFinance || !definition.managersOnly))
    .map(([type, definition]) => ({ card: { type }, description: definition.subtitle ?? '', title: definition.title }));
  const reportCards = reports
    .filter((report) => report.status !== 'inactive' && !shown.has(`${REPORT_CARD_TYPE}:${report.id}`))
    .map((report) => ({ card: { reportId: report.id, type: REPORT_CARD_TYPE }, description: report.description || `${report.dataset.replaceAll('_', ' ')} report`, title: report.name }));
  return { builtIn, reports: reportCards };
}
