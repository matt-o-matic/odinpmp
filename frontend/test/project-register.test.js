import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PROJECT_FILTERS,
  buildProjectRows,
  formatProjectDates,
  menuProjects,
  normalizeProjectStatus,
  projectEndNote,
  projectFiltersFromQuery,
  projectFiltersToQuery,
  projectStatusCounts,
  projectStatusTone,
  reviewDeadline,
  summarizeAttention,
  waitingBreakdown,
} from '../src/lib/projects/project-register.js';

const now = new Date(2026, 9, 12, 10, 0, 0);
const projects = [
  { id: 'a', name: 'Alpha', rank: 2, status: 'In Progress', endDate: '2026-10-20', updatedAt: '2026-10-01T00:00:00.000Z' },
  { id: 'b', name: 'bravo', rank: 1, status: 'Planned', endDate: null, updatedAt: '2026-10-05T00:00:00.000Z' },
  { id: 'c', name: 'Charlie', rank: null, status: 'Archived', endDate: '2026-01-01' },
  { id: 'd', name: 'Delta', rank: null, status: 'Abandoned' },
  { id: 'e', name: 'Echo', rank: 3, status: 'At Risk', endDate: '2026-10-09' },
];
const waiting = (total, extra = {}) => ({ answer: 0, decide: 0, drafts: 0, review: 0, ...extra, total });
const signals = {
  a: { projectId: 'a', review: { awaitingYou: false, dueAt: new Date(2026, 9, 10).toISOString(), id: 'r1', number: 1, openCount: 1, track: 'experience' }, waiting: waiting(0) },
  b: { projectId: 'b', review: { awaitingYou: true, dueAt: new Date(2026, 9, 14, 17).toISOString(), id: 'r2', number: 2, openCount: 1, track: 'architecture' }, waiting: waiting(3, { answer: 2, review: 1 }) },
  e: { projectId: 'e', review: null, waiting: waiting(1, { decide: 1 }) },
};

test('legacy status names land on a canonical status', () => {
  assert.equal(normalizeProjectStatus('Abandoned'), 'Archived');
  assert.equal(normalizeProjectStatus('under_review'), 'Review');
  assert.equal(normalizeProjectStatus(''), 'Planned');
  assert.equal(normalizeProjectStatus('Something else'), 'Something else');
  assert.deepEqual(projectStatusTone('Done'), { icon: 'bi-check-circle-fill', label: 'Completed', tone: 'done' });
});

test('archived projects stay out of the default view and the navbar menu', () => {
  const ids = buildProjectRows(projects, signals, DEFAULT_PROJECT_FILTERS).map((row) => row.project.id);
  assert.deepEqual(ids, ['b', 'a', 'e']);
  assert.deepEqual(menuProjects(projects).map((project) => project.id), ['a', 'b', 'e']);
  assert.deepEqual(menuProjects(projects, 1).map((project) => project.id), ['a']);
  const archived = buildProjectRows(projects, signals, { ...DEFAULT_PROJECT_FILTERS, status: 'Archived' });
  assert.deepEqual(archived.map((row) => row.project.id), ['c', 'd']);
});

test('status counts treat every non-archived project as active', () => {
  const counts = projectStatusCounts(projects);
  assert.equal(counts.active, 3);
  assert.equal(counts.Archived, 2);
  assert.equal(counts.Planned, 1);
  assert.equal(counts.Review, 0);
});

test('text, waiting-on-me and status filters combine', () => {
  assert.deepEqual(buildProjectRows(projects, signals, { ...DEFAULT_PROJECT_FILTERS, q: 'BRA' }).map((row) => row.project.id), ['b']);
  assert.deepEqual(buildProjectRows(projects, signals, { ...DEFAULT_PROJECT_FILTERS, mine: true }).map((row) => row.project.id), ['b', 'e']);
  assert.deepEqual(buildProjectRows(projects, signals, { ...DEFAULT_PROJECT_FILTERS, status: 'At Risk' }).map((row) => row.project.id), ['e']);
  assert.deepEqual(buildProjectRows(projects, {}, { ...DEFAULT_PROJECT_FILTERS, mine: true }), []);
});

test('sort orders', () => {
  const order = (sort) => buildProjectRows(projects, signals, { ...DEFAULT_PROJECT_FILTERS, sort }).map((row) => row.project.id);
  assert.deepEqual(order('rank'), ['b', 'a', 'e']);
  assert.deepEqual(order('name'), ['a', 'b', 'e']);
  assert.deepEqual(order('waiting'), ['b', 'e', 'a']);
  assert.deepEqual(order('review'), ['a', 'b', 'e']);
  assert.deepEqual(order('status'), ['b', 'a', 'e']);
  assert.deepEqual(order('end'), ['e', 'a', 'b']);
  assert.deepEqual(order('updated'), ['b', 'a', 'e']);
});

test('filters round-trip through the route query and drop unknown values', () => {
  assert.deepEqual(projectFiltersFromQuery({}), DEFAULT_PROJECT_FILTERS);
  assert.deepEqual(projectFiltersFromQuery({ mine: '1', q: 'aca ', sort: 'bogus', status: 'nope' }), { mine: true, q: 'aca ', sort: 'rank', status: 'active' });
  assert.deepEqual(projectFiltersToQuery(DEFAULT_PROJECT_FILTERS, { new: 'project' }), { new: 'project' });
  assert.deepEqual(
    projectFiltersToQuery({ mine: true, q: 'aca ', sort: 'name', status: 'Archived' }, { q: 'old' }),
    { mine: '1', q: 'aca ', sort: 'name', status: 'Archived' },
  );
  assert.deepEqual(projectFiltersToQuery({ ...DEFAULT_PROJECT_FILTERS, q: '   ' }), {});
});

test('review deadlines read as a countdown with an urgency tone', () => {
  const at = (day, hour = 17) => ({ dueAt: new Date(2026, 9, day, hour).toISOString() });
  assert.equal(reviewDeadline(null), null);
  assert.deepEqual(reviewDeadline({ dueAt: null }, { now }), { dateText: '', label: 'Open, no close date', tone: 'none' });
  assert.equal(reviewDeadline(at(12), { now }).tone, 'soon');
  assert.match(reviewDeadline(at(12), { now }).label, /^Closes today, /);
  assert.deepEqual([reviewDeadline(at(13), { now }).label, reviewDeadline(at(13), { now }).tone], ['Closes tomorrow', 'soon']);
  assert.deepEqual([reviewDeadline(at(14), { now }).label, reviewDeadline(at(14), { now }).tone], ['Closes in 2 days', 'soon']);
  assert.deepEqual([reviewDeadline(at(20), { now }).label, reviewDeadline(at(20), { now }).tone], ['Closes in 8 days', 'open']);
  assert.deepEqual([reviewDeadline(at(12, 8), { now }).label, reviewDeadline(at(12, 8), { now }).tone], ['Overdue since earlier today', 'overdue']);
  assert.equal(reviewDeadline(at(11), { now }).label, '1 day overdue');
  assert.equal(reviewDeadline(at(9), { now }).label, '3 days overdue');
});

test('the attention line counts items and owed reviews outside archived projects', () => {
  const withArchived = { ...signals, c: { projectId: 'c', review: null, waiting: waiting(9) } };
  const summary = summarizeAttention(projects, withArchived, { now });
  assert.equal(summary.items, 4);
  assert.equal(summary.projectsWithItems, 2);
  assert.equal(summary.reviewsOwed, 1);
  assert.equal(summary.soonestReview.project.id, 'b');
});

test('waiting breakdown, end-date notes and date ranges', () => {
  assert.equal(waitingBreakdown(signals.b), '2 to answer · 1 to review');
  assert.equal(waitingBreakdown(null), '');
  assert.deepEqual(projectEndNote(projects[0], { now }), { text: 'Ends in 8 days', tone: 'open' });
  assert.deepEqual(projectEndNote(projects[4], { now }), { text: 'Past end date', tone: 'overdue' });
  assert.deepEqual(projectEndNote({ endDate: '2026-10-12', status: 'Planned' }, { now }), { text: 'Ends today', tone: 'soon' });
  assert.equal(projectEndNote({ endDate: '2026-10-01', status: 'Completed' }, { now }), null);
  assert.equal(projectEndNote({ endDate: '2026-12-01', status: 'Planned' }, { now }), null);
  assert.equal(formatProjectDates('2026-08-01', '2026-10-20', { locale: 'en-US' }), 'Aug 1, 2026 – Oct 20, 2026');
  assert.equal(formatProjectDates(null, '2026-10-20', { locale: 'en-US' }), 'Ends Oct 20, 2026');
  assert.equal(formatProjectDates(null, null), '');
});
