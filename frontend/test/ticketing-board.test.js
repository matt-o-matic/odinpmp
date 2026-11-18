import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_TICKET_COLUMNS,
  buildTicketBoard,
  buildTicketColumns,
  buildTicketFilterQuery,
  categoryLabel,
  createTicketFilterState,
  isAwaitingReview,
  reopenCount,
  reopenLabel,
  reviewCheckLabel,
  reviewStateLabel,
  severityLabel,
  summarizeTickets,
} from '../src/lib/projects/ticket-board.js';

const ticketsViewSource = readFileSync(new URL('../src/views/TicketsView.vue', import.meta.url), 'utf8');
const projectPanelSource = readFileSync(new URL('../src/components/projects/ProjectTicketsPanel.vue', import.meta.url), 'utf8');
const routerSource = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const projectDetailSource = readFileSync(new URL('../src/views/ProjectDetailView.vue', import.meta.url), 'utf8');

function ticket(id, overrides = {}) {
  return { category: 'defect', externalReviewState: 'not_external', id, name: `Ticket ${id}`, severity: 'S3', status: 'new', ...overrides };
}

const TICKET_WORKFLOW = {
  states: [
    { category: 'backlog', key: 'new', label: 'New' },
    { category: 'backlog', key: 'triage', label: 'Triage' },
    { category: 'backlog', key: 'open', label: 'Open' },
    { category: 'active', key: 'in_progress', label: 'In Progress' },
    { category: 'active', key: 'resolved', label: 'Resolved' },
    { category: 'done', key: 'closed', label: 'Closed' },
    { category: 'cancelled', key: 'rejected', label: 'Rejected' },
    { category: 'cancelled', key: 'deferred', label: 'Deferred' },
  ],
};

test('AC8.3 columns come from the bound workflow, folding cancelled states into done', () => {
  const columns = buildTicketColumns(TICKET_WORKFLOW);

  assert.deepEqual(columns.map((column) => column.key), ['new', 'triage', 'open', 'in_progress', 'resolved', 'closed']);
  assert.deepEqual(columns.at(-1).statuses, ['closed', 'rejected', 'deferred']);
});

test('AC3.4 a custom workflow still produces columns', () => {
  const columns = buildTicketColumns({
    states: [
      { category: 'backlog', key: 'reported', label: 'Reported' },
      { category: 'active', key: 'working', label: 'Working' },
      { category: 'done', key: 'shipped', label: 'Shipped' },
    ],
  });

  assert.deepEqual(columns.map((column) => column.key), ['reported', 'working', 'shipped']);
});

test('a workflow with only cancelled terminal states still gets a column', () => {
  const columns = buildTicketColumns({
    states: [
      { category: 'backlog', key: 'new', label: 'New' },
      { category: 'cancelled', key: 'dropped', label: 'Dropped' },
    ],
  });

  assert.deepEqual(columns.map((column) => column.key), ['new', 'dropped']);
  assert.deepEqual(columns.at(-1).statuses, ['dropped']);
});

test('an absent workflow falls back to the seeded default lifecycle', () => {
  assert.deepEqual(buildTicketColumns(null).map((column) => column.key), DEFAULT_TICKET_COLUMNS.map((column) => column.key));
  assert.deepEqual(buildTicketColumns({ states: [] }).map((column) => column.key), DEFAULT_TICKET_COLUMNS.map((column) => column.key));
});

test('the fallback never shares array references with the exported default', () => {
  const columns = buildTicketColumns(null);
  columns[0].statuses.push('mutated');

  assert.deepEqual(DEFAULT_TICKET_COLUMNS[0].statuses, ['new'], 'the exported default is not mutated');
});

test('tickets are distributed into their matching columns', () => {
  const board = buildTicketBoard(
    [ticket('a'), ticket('b', { status: 'open' }), ticket('c', { status: 'closed' }), ticket('d', { status: 'rejected' })],
    buildTicketColumns(TICKET_WORKFLOW),
  );

  const byKey = new Map(board.map((column) => [column.key, column]));
  assert.deepEqual(byKey.get('new').tickets.map((entry) => entry.id), ['a']);
  assert.deepEqual(byKey.get('open').tickets.map((entry) => entry.id), ['b']);
  assert.deepEqual(byKey.get('closed').tickets.map((entry) => entry.id), ['c', 'd']);
});

test('a ticket whose status matches no column is surfaced rather than dropped', () => {
  const board = buildTicketBoard([ticket('a', { status: 'invented_state' })], buildTicketColumns(TICKET_WORKFLOW));
  const unmapped = board.find((column) => column.key === '__unmapped');

  assert.ok(unmapped, 'an explicit Unmapped column appears');
  assert.deepEqual(unmapped.tickets.map((entry) => entry.id), ['a']);
});

test('no unmapped column appears when every ticket maps', () => {
  const board = buildTicketBoard([ticket('a')], buildTicketColumns(TICKET_WORKFLOW));
  assert.equal(board.some((column) => column.key === '__unmapped'), false);
});

test('summary counts totals, open work, severity, and review backlog', () => {
  const summary = summarizeTickets([
    ticket('a', { severity: 'S1' }),
    ticket('b', { severity: 'S1', status: 'closed' }),
    ticket('c', { externalReviewState: 'pending', severity: 'S3' }),
    ticket('d', { severity: 'S4', status: 'deferred' }),
  ]);

  assert.equal(summary.total, 4);
  assert.equal(summary.open, 2);
  assert.equal(summary.bySeverity.S1, 2);
  assert.equal(summary.awaitingReview, 1);
});

test('AC8.4 pending-review tickets are distinguishable', () => {
  assert.equal(isAwaitingReview(ticket('a', { externalReviewState: 'pending' })), true);
  assert.equal(isAwaitingReview(ticket('a', { externalReviewState: 'validated' })), false);
  assert.equal(isAwaitingReview(ticket('a')), false);
});

test('labels are human-readable and fall back safely', () => {
  assert.equal(categoryLabel('change_request'), 'Change request');
  assert.equal(categoryLabel('defect'), 'Defect');
  assert.equal(categoryLabel('nonsense'), 'Defect');
  assert.equal(severityLabel('S1'), 'S1 · Critical');
  assert.equal(severityLabel('S9'), 'S3 · Minor');
  assert.equal(reviewStateLabel('pending'), 'Awaiting review');
  assert.equal(reviewStateLabel('not_external'), 'Internal');
  assert.equal(reviewStateLabel(undefined), 'Internal');
});

test('the review queue hints at the automated check of each ticket without deciding it', () => {
  assert.equal(reviewCheckLabel(null), 'Not checked');
  assert.equal(reviewCheckLabel({ recommendation: 'validate', safety: 'safe' }), 'Looks safe');
  assert.equal(reviewCheckLabel({ recommendation: 'person', safety: 'caution' }), 'Check carefully');
  assert.equal(reviewCheckLabel({ recommendation: 'person', safety: 'unsafe' }), 'Looks unsafe');
  assert.equal(reviewCheckLabel({ recommendation: 'reject', safety: 'safe' }), 'Looks like spam');
  assert.equal(reviewCheckLabel({ recommendation: 'person', safety: 'safe' }), 'Unclear');
  assert.match(ticketsViewSource, /apiClient\.passive\.listTicketsAwaitingReview\(projectId, \{ limit: 25 \}/);
  assert.match(ticketsViewSource, /<td>\{\{ reviewCheckLabel\(reviewChecks\.get\(ticket\.id\)\) \}\}<\/td>/);
  // Each check may cost an OpenAI call, so filter changes and refreshes don't load them again.
  assert.match(ticketsViewSource, /if \(!reviewChecksRequested\) loadReviewChecks\(reviewQueue\.value\);/);
  assert.equal(ticketsViewSource.match(/loadReviewChecks\(/g).length, 2, 'declared once and called from one place');
});

test('AC8.2 filter state converts to the query the API expects', () => {
  const filters = createTicketFilterState({ categories: ['defect'], search: '  checkout  ', severities: ['S1', 'S2'] });

  assert.deepEqual(buildTicketFilterQuery(filters), {
    categories: ['defect'],
    limit: 50,
    search: 'checkout',
    severities: ['S1', 'S2'],
  });
});

test('AC8.2 untouched filters never become restrictions', () => {
  const query = buildTicketFilterQuery(createTicketFilterState());

  assert.deepEqual(Object.keys(query), ['limit']);
  assert.equal(Object.hasOwn(query, 'categories'), false);
  assert.equal(Object.hasOwn(query, 'search'), false);
});

test('the query does not alias the filter arrays', () => {
  const filters = createTicketFilterState({ severities: ['S1'] });
  const query = buildTicketFilterQuery(filters);
  query.severities.push('S2');

  assert.deepEqual(filters.severities, ['S1']);
});

test('AC8.1 the tenant board route and navigation entry exist', () => {
  assert.match(routerSource, /path: '\/tickets'/);
  assert.match(routerSource, /name: 'tickets'/);
  assert.match(appSource, /:to="\{ name: 'tickets' \}"/);
});

test('AC9.1 the project workbench exposes a tickets tab on its own route', () => {
  assert.match(routerSource, /path: '\/projects\/:projectId\/tickets'/);
  assert.match(routerSource, /name: 'project-tickets'/);
  assert.match(projectDetailSource, /ProjectTicketsPanel/);
  assert.match(projectDetailSource, /activeWorkspace === 'tickets'/);
});

test('AC8.1 the tenant board queries across projects and offers a review queue', () => {
  // Live refreshes call the same routes through the background client.
  assert.match(ticketsViewSource, /(?:apiClient|client)\.listTickets\(/);
  assert.match(ticketsViewSource, /(?:apiClient|client)\.listTicketReviewQueue\(/);
  assert.match(ticketsViewSource, /apiClient\.decideTicketReview/);
});

test('AC9.2 the project panel creates tickets in the current project with no project picker', () => {
  assert.match(projectPanelSource, /\.listProjectTickets\(/);
  assert.match(projectPanelSource, /itemType: 'ticket'/);
  assert.match(projectPanelSource, /props\.projectId/);
  assert.equal(projectPanelSource.includes('projectIds'), false, 'the project filter is suppressed');
});

test('AC9.4 the project panel does not put new tickets on a sprint', () => {
  assert.equal(/sprintId/.test(projectPanelSource), false);
});

test('AC8.7 both surfaces carry a narrow-width layout and touch-sized controls', () => {
  for (const source of [ticketsViewSource, projectPanelSource]) {
    assert.match(source, /@media\(max-width:48rem\)/);
    assert.match(source, /min-height:2\.75rem/);
  }
});

test('AC11.3 interactive controls have accessible names and visible focus', () => {
  assert.match(ticketsViewSource, /aria-label="Close ticket detail"/);
  assert.match(ticketsViewSource, /focus-visible/);
  assert.match(projectPanelSource, /aria-label="Close new ticket form"/);
  assert.match(projectPanelSource, /focus-visible/);

  // Every filter and form control is explicitly associated with its label.
  for (const source of [ticketsViewSource, projectPanelSource]) {
    const ids = [...source.matchAll(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(ids.length > 0, 'the surface has form controls');
    for (const id of ids) {
      assert.ok(source.includes(`for="${id}"`), `control ${id} has an associated label`);
    }
  }
});

test('reopen counts are read defensively and labelled for people', () => {
  assert.equal(reopenCount(ticket('a', { reopenCount: 2 })), 2);
  assert.equal(reopenCount(ticket('a')), 0);
  assert.equal(reopenCount(ticket('a', { reopenCount: -1 })), 0);
  assert.equal(reopenCount(null), 0);
  assert.equal(reopenLabel(1), 'Reopened 1 time');
  assert.equal(reopenLabel(3), 'Reopened 3 times');
});

test('the reopened filter is sent only when chosen', () => {
  assert.equal(Object.hasOwn(buildTicketFilterQuery(createTicketFilterState()), 'reopened'), false);
  assert.equal(buildTicketFilterQuery(createTicketFilterState({ reopened: true })).reopened, true);
  assert.match(ticketsViewSource, /id="ticket-reopened" v-model="filters\.reopened"/);
});

test('both ticket surfaces show the reopen badge, and the card badge sits outside the card button', () => {
  const badgeSource = readFileSync(new URL('../src/components/projects/TicketReopenBadge.vue', import.meta.url), 'utf8');
  for (const source of [ticketsViewSource, projectPanelSource]) assert.match(source, /<TicketReopenBadge v-if="reopenCount\(ticket\)"/);
  assert.match(ticketsViewSource, /<\/button>\s*<!--[^>]*-->\s*<span v-if="reopenCount\(ticket\)" class="ticket-card__reopen">/);
  assert.match(ticketsViewSource, /Reopened by reporter/);
  assert.match(badgeSource, /:aria-label="label"/);
  // The explanation is an in-flow disclosure, not a floating tooltip that could cover the next ticket.
  assert.match(badgeSource, /:aria-controls="noteId"/);
  assert.match(badgeSource, /:aria-expanded="open \? 'true' : 'false'"/);
  assert.match(badgeSource, /<span v-show="open" :id="noteId" class="ticket-reopen-note"/);
  assert.doesNotMatch(badgeSource, /role="tooltip"|<Teleport|popover/);
  assert.equal(/\stitle=/.test(badgeSource), false, 'no title-attribute tooltip');
});

test('the tenant board scrolls wide content inside its own container', () => {
  assert.match(ticketsViewSource, /overflow-x:auto/);
  assert.match(ticketsViewSource, /table-responsive/);
});
