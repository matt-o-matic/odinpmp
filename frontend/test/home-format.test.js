import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dayLabel,
  dueLabel,
  failedSourcesMessage,
  firstNameOf,
  greetingFor,
  initials,
  itemsForTab,
  percentWidth,
  reasonIcon,
  roleSummary,
  sourceFailed,
  sparklinePaths,
  sprintEndLabel,
} from '../src/lib/home/home-format.js';

// Monday 2026-10-12, 15:00 UTC.
const AS_OF = '2026-10-12T15:00:00.000Z';

test('row dates read relative to the payload time', () => {
  assert.equal(dueLabel({ at: '2026-10-12', kind: 'due' }, AS_OF), 'Today');
  assert.equal(dueLabel({ at: '2026-10-13', kind: 'due' }, AS_OF), 'Tomorrow');
  assert.equal(dueLabel({ at: '2026-10-16', kind: 'due' }, AS_OF), 'Fri');
  assert.equal(dueLabel({ at: '2026-10-28', kind: 'due' }, AS_OF), 'Oct 28');
  assert.equal(dueLabel({ at: '2026-10-07', kind: 'due' }, AS_OF), 'Was due Wed');
  assert.equal(dueLabel({ at: '2026-09-30', kind: 'due' }, AS_OF), 'Was due Sep 30');
  // A time earlier today reads in hours.
  assert.equal(dueLabel({ at: '2026-10-12T12:00:00.000Z', kind: 'due' }, AS_OF), 'Overdue 3h');
  assert.equal(dueLabel({ at: '2026-10-07T09:00:00.000Z', kind: 'since' }, AS_OF), 'Since Oct 7');
  assert.equal(dueLabel({ at: null, kind: 'owner' }, AS_OF), 'Owner');
  assert.equal(dueLabel(null, AS_OF), '');
  assert.equal(dayLabel('2026-10-14', '2026-10-12'), 'Wed');
});

test('sprint end dates read as a weekday this week, else days left', () => {
  assert.equal(sprintEndLabel('2026-10-16', AS_OF), 'ends Fri');
  assert.equal(sprintEndLabel('2026-10-12', AS_OF), 'ends today');
  assert.equal(sprintEndLabel('2026-10-24', AS_OF), '12 days left');
  assert.equal(sprintEndLabel('2026-10-09', AS_OF), 'ended Oct 9');
});

test('the greeting and role line follow the time and the viewer', () => {
  assert.equal(greetingFor(new Date(2026, 9, 12, 9)), 'Good morning');
  assert.equal(greetingFor(new Date(2026, 9, 12, 14)), 'Good afternoon');
  assert.equal(greetingFor(new Date(2026, 9, 12, 19)), 'Good evening');
  assert.equal(firstNameOf('Priya Natarajan'), 'Priya');
  assert.equal(firstNameOf(''), 'there');
  assert.equal(roleSummary({ managedProjectCount: 4, projectCount: 6, tenantRole: 'user' }), 'Manager on 4 projects');
  assert.equal(roleSummary({ managedProjectCount: 0, projectCount: 1, tenantRole: 'user' }), 'Member on 1 project');
  assert.equal(roleSummary({ managedProjectCount: 0, projectCount: 3, tenantRole: 'admin' }, 'Northwind Traders'), 'Tenant admin, Northwind Traders');
  assert.equal(roleSummary({ managedProjectCount: 0, projectCount: 0, tenantRole: 'user' }, 'Acme'), 'Member of Acme');
});

test('a failing ranking source is named with how many projects it missed', () => {
  const sources = [
    { failedProjectIds: [], key: 'projects', status: 'ok' },
    { failedProjectIds: ['p1', 'p2'], key: 'requirements', status: 'error' },
    { failedProjectIds: [], key: 'leaderboard', status: 'error' },
  ];
  assert.equal(failedSourcesMessage(sources, 5), 'Requirements items could not load for 2 of 5 projects, so the ranking may be missing items.');
  assert.equal(failedSourcesMessage([...sources, { failedProjectIds: ['p2'], key: 'relations', status: 'error' }], 5), 'Requirements items and item links could not load for 2 of 5 projects, so the ranking may be missing items.');
  assert.equal(failedSourcesMessage([{ failedProjectIds: [], key: 'workflows', status: 'error' }], 5), 'Workflow approvals could not load, so the ranking may be missing items.');
  // Rail-only sources report in their own panels.
  assert.equal(failedSourcesMessage([sources[2]], 5), '');
  assert.equal(sourceFailed(sources, 'leaderboard'), true);
  assert.equal(sourceFailed(sources, 'projects'), false);
});

test('tabs list the focus items or the items tagged with the tab', () => {
  const payload = { focus: { items: [{ id: 'a' }] }, items: [{ id: 'a', tabs: ['focus', 'assigned', 'all'] }, { id: 'b', tabs: ['requirements', 'all'] }] };
  assert.deepEqual(itemsForTab(payload, 'focus').map((item) => item.id), ['a']);
  assert.deepEqual(itemsForTab(payload, 'requirements').map((item) => item.id), ['b']);
  assert.deepEqual(itemsForTab(payload, 'all').map((item) => item.id), ['a', 'b']);
  assert.deepEqual(itemsForTab(null, 'all'), []);
});

test('the sparkline spans the box and ends on the last day', () => {
  const { area, last, line } = sparklinePaths([{ count: 2 }, { count: 6 }, { count: 4 }], 320, 56);
  assert.equal(line, 'M0.0,50.0 L160.0,8.0 L320.0,29.0');
  assert.equal(area, `${line} L320,56 L0,56 Z`);
  assert.deepEqual(last, { x: 320, y: 29 });
  assert.deepEqual(sparklinePaths([]), { area: '', last: null, line: '' });
});

test('small helpers clamp and fall back', () => {
  assert.equal(percentWidth(16, 34), 47);
  assert.equal(percentWidth(40, 34), 100);
  assert.equal(percentWidth(1, 0), 0);
  assert.equal(initials('Priya Natarajan'), 'PN');
  assert.equal(initials('Sam'), 'S');
  assert.equal(reasonIcon('blocks'), 'bi-people-fill');
  assert.equal(reasonIcon('unknown'), 'bi-dot');
});
