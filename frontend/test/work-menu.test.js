import assert from 'node:assert/strict';
import test from 'node:test';

import { menuEngagements, menuTickets, takeNewQuery, ticketMenuLocation, WORK_MENU_RECENT } from '../src/lib/workspace/work-menu.js';

test('the Work menu lists open engagements, the most recently active first', () => {
  const engagements = [
    { id: 'a', lastActivityAt: '2026-11-10T10:00:00Z', name: 'Alpha', status: 'open' },
    { id: 'b', lastActivityAt: '2026-11-14T10:00:00Z', name: 'Bravo', status: 'open' },
    { id: 'c', lastActivityAt: '2026-11-15T10:00:00Z', name: 'Charlie', status: 'won', kind: 'delivery' },
    { id: 'd', lastActivityAt: '2026-11-15T09:00:00Z', name: 'Delta', status: 'lost' },
  ];
  assert.deepEqual(menuEngagements(engagements).map(({ id }) => id), ['b', 'a']);
  assert.deepEqual(menuEngagements(null), []);
});

test('the Work menu keeps at most a few recent entries', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ id: `t${index}`, name: `T${index}`, projectId: 'p1' }));
  assert.equal(menuTickets(many).length, WORK_MENU_RECENT);
  assert.equal(menuEngagements(many.map((entry) => ({ ...entry, status: 'open' }))).length, WORK_MENU_RECENT);
  assert.deepEqual(menuTickets([{ id: 'x' }, { id: 'y', projectId: 'p' }]).map(({ id }) => id), ['y']);
});

test('a ticket in the menu opens on the Tickets page', () => {
  assert.deepEqual(ticketMenuLocation({ id: 't1', projectId: 'p1' }), { name: 'tickets', query: { project: 'p1', ticket: 't1' } });
});

test('?new= opens a page\'s create form once, and leaves the rest of the query', () => {
  assert.deepEqual(takeNewQuery({ new: 'ticket', status: 'open' }, 'ticket'), { open: true, query: { status: 'open' } });
  assert.deepEqual(takeNewQuery({ new: 'project' }, 'ticket'), { open: false, query: { new: 'project' } });
  assert.equal(takeNewQuery({}, 'engagement').open, false);
});
