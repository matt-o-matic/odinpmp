import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { columnPath, dayTicks, linePath, niceTicks } from '../src/lib/insights/chart-geometry.js';
import { actionLocation, deliveryLabel, evidenceLocation, formatDay, formatNumber, withUnit } from '../src/lib/insights/insights-format.js';
import {
  DEFAULT_INSIGHTS_CARDS,
  addCard,
  addableCards,
  cardKey,
  isDefaultLayout,
  moveCard,
  removeCard,
  sameCards,
} from '../src/lib/insights/insights-layout.js';
import { reportingQueryFor, reportingStateFromQuery } from '../src/lib/search/reporting-deep-link.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the default layout follows design A and lists every built-in card once', () => {
  assert.deepEqual(DEFAULT_INSIGHTS_CARDS.map(cardKey), [
    'gantt', 'headline', 'burnup', 'sprint-burndown', 'velocity', 'cumulative-flow', 'ticket-flow',
    'tickets-by-severity', 'milestones', 'earned-value', 'throughput', 'saved-reports',
  ]);
  assert.equal(isDefaultLayout(DEFAULT_INSIGHTS_CARDS.map((card) => ({ ...card }))), true);
});

test('edit mode moves, removes and adds cards without duplicates', () => {
  const cards = [{ type: 'burnup' }, { type: 'velocity' }, { type: 'milestones' }];
  assert.deepEqual(moveCard(cards, 2, -1).map(cardKey), ['burnup', 'milestones', 'velocity']);
  assert.equal(moveCard(cards, 0, -1), cards, 'the first card cannot move earlier');
  assert.deepEqual(removeCard(cards, 1).map(cardKey), ['burnup', 'milestones']);
  const withReport = addCard(cards, { reportId: 'r-1', type: 'report' });
  assert.deepEqual(withReport.map(cardKey), ['burnup', 'velocity', 'milestones', 'report:r-1']);
  assert.equal(addCard(withReport, { reportId: 'r-1', type: 'report' }), withReport);
  assert.equal(sameCards(cards, [...cards]), true);
  assert.equal(sameCards(cards, moveCard(cards, 0, 1)), false);
});

test('only people who can see cost may add the earned value card; inactive reports are not offered', () => {
  const cards = [{ type: 'burnup' }];
  const reports = [
    { dataset: 'work_items', description: '', id: 'r-1', name: 'Open work', status: 'active' },
    { dataset: 'sprint', description: 'Old', id: 'r-2', name: 'Retired', status: 'inactive' },
  ];
  const member = addableCards(cards, { canSeeFinance: false, reports });
  assert.ok(!member.builtIn.some((option) => option.card.type === 'earned-value'));
  assert.ok(!member.builtIn.some((option) => option.card.type === 'burnup'));
  assert.deepEqual(member.reports.map((option) => [option.title, option.description]), [['Open work', 'work items report']]);
  assert.ok(addableCards(cards, { canSeeFinance: true, reports }).builtIn.some((option) => option.card.type === 'earned-value'));
});

test('evidence and card actions become project routes', () => {
  assert.deepEqual(evidenceLocation({ id: 'task-1', projectId: 'p-1', type: 'item' }, 'p-1'), { name: 'project-detail', params: { projectId: 'p-1' }, query: { item: 'task-1' } });
  assert.deepEqual(evidenceLocation({ id: 's-1', projectId: 'p-1', type: 'sprint' }, 'p-1'), { name: 'project-sprints', params: { projectId: 'p-1' } });
  assert.equal(evidenceLocation({ id: 'm-1', type: 'milestone' }, 'p-2').name, 'project-governance');
  assert.equal(evidenceLocation(null, 'p-1'), null);
  assert.deepEqual(actionLocation('tickets', 'p-1'), { name: 'project-tickets', params: { projectId: 'p-1' } });
});

test('numbers, days and delivery read the same on every card', () => {
  assert.equal(formatDay('2026-10-09'), 'Oct 9');
  assert.equal(formatDay('2026-10-09', { withYear: true }), 'Oct 9, 2026');
  assert.equal(formatNumber(12.345), '12.3');
  assert.equal(formatNumber(1200, { compact: true }), '1.2K');
  assert.equal(withUnit(1, 'points'), '1 pt');
  assert.equal(withUnit(3, 'items'), '3 items');
  assert.equal(deliveryLabel({ channel: 'email', enabled: true, intervalMinutes: 10080 }), 'Email · weekly');
  assert.equal(deliveryLabel(null), '—');
});

test('chart geometry rounds axes and draws data-ended columns', () => {
  assert.deepEqual(niceTicks(27), { max: 30, ticks: [0, 10, 20, 30] });
  assert.deepEqual(niceTicks(0), { max: 1, ticks: [0, 1] });
  assert.deepEqual(dayTicks('2026-10-01', '2026-10-09', 3), ['2026-10-01', '2026-10-05', '2026-10-09']);
  assert.equal(linePath([{ x: 0, y: 10 }, { x: 5, y: null }, { x: 10, y: 4 }, { x: 20, y: 2 }]), 'M0,10M10,4L20,2');
  assert.equal(columnPath(0, 10, 100, 100), '');
  assert.match(columnPath(0, 10, 20, 100), /^M0,100V24Q0,20 4,20H6Q10,20 10,24V100Z$/);
});

test('/reports reads and writes its project and tab in the URL', () => {
  assert.deepEqual(reportingStateFromQuery({ projectId: 'p-1', tab: 'Reports' }), { projectId: 'p-1', tab: 'reports' });
  assert.deepEqual(reportingStateFromQuery({ tab: 'nope' }), { projectId: '', tab: 'dashboards' });
  assert.deepEqual(reportingQueryFor({ other: '1', tab: 'runs' }, { projectId: 'p-1', tab: 'dashboards' }), { other: '1', projectId: 'p-1' });
});

test('the project gets an Insights tab, and its right pane links there instead of dead Reports and Analytics links', async () => {
  const view = await read('../src/views/ProjectDetailView.vue');
  const router = await read('../src/router/index.js');
  assert.match(router, /path: '\/projects\/:projectId\/insights',\s*name: 'project-insights'/);
  assert.match(router, /:legacy\(reports\|analytics\)/);
  assert.match(view, /:to="\{ name: 'project-insights', params: \{ projectId: project\.id \} \}"\s*>\s*Insights\s*<\/RouterLink>/);
  assert.match(view, /<ProjectInsightsWorkspace\s+v-else-if="activeWorkspace === 'insights'"/);
  assert.doesNotMatch(view, /@click\.prevent>Reports</);
  assert.doesNotMatch(view, /Analytics<\/a>/);
  // The compact Project Stats summary stays in the right pane.
  assert.match(view, /Project Stats/);
});

test('Insights has no Run button, keeps edit mode explicit and styles its own card titles', async () => {
  const workspace = await read('../src/components/projects/insights/ProjectInsightsWorkspace.vue');
  const reportCard = await read('../src/components/projects/insights/InsightsReportCard.vue');
  const card = await read('../src/components/projects/insights/InsightsCard.vue');
  const styles = await read('../src/components/projects/insights/insights.css');
  assert.doesNotMatch(`${workspace}${reportCard}`, />\s*Run\s*</);
  assert.match(reportCard, /getProjectInsightsReportCard/);
  assert.match(workspace, /v-if="viewer\.canEditLayout && !editing"/);
  assert.match(card, /<h3 :id="titleId" class="insights-card__title">/);
  assert.match(styles, /\.insights \.insights-card__title,\s*\.insights \.insights-editbar__title \{ font-size: 1rem !important;/);
  assert.match(styles, /html\.dark \.insights \{/);
  // No tooltip title attributes (a bound :title is the card component's heading prop).
  assert.doesNotMatch(`${workspace}${reportCard}${card}`, /\stitle="/);
  assert.doesNotMatch(`${workspace}${reportCard}${card}`, /window\.(alert|confirm)\(/);
});

test('the reporting page keeps its project and tab in the URL and links back to Insights', async () => {
  const view = await read('../src/views/ReportingView.vue');
  assert.match(view, /reportingStateFromQuery\(route\.query\)/);
  assert.match(view, /router\.replace\(\{ query \}\)/);
  assert.match(view, /name: 'project-insights'/);
});
