<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';

import InsightsBarList from './InsightsBarList.vue';
import InsightsCard from './InsightsCard.vue';
import InsightsColumnChart from './InsightsColumnChart.vue';
import InsightsDataTable from './InsightsDataTable.vue';
import InsightsFlowChart from './InsightsFlowChart.vue';
import InsightsGanttChart from './InsightsGanttChart.vue';
import InsightsHeadlineTiles from './InsightsHeadlineTiles.vue';
import InsightsLineChart from './InsightsLineChart.vue';
import InsightsMilestoneChart from './InsightsMilestoneChart.vue';
import InsightsSavedReports from './InsightsSavedReports.vue';
import { ganttTableRows } from '../../../lib/insights/gantt.js';
import { INSIGHTS_CARDS } from '../../../lib/insights/insights-layout.js';
import { actionLocation, formatDay, formatMoney, formatNumber, reportsLocation, unitLabel, withUnit } from '../../../lib/insights/insights-format.js';

// One built-in card: picks the chart and the table view for its type from the card payload
// the Insights endpoint returns ({ status, data, message, notes, availableOn, action }).

const props = defineProps({
  canMoveDown: { default: false, type: Boolean },
  canMoveUp: { default: false, type: Boolean },
  card: { default: null, type: Object },
  editing: { default: false, type: Boolean },
  loading: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  refreshing: { default: false, type: Boolean },
  type: { required: true, type: String },
  unit: { default: 'points', type: String },
});

const emit = defineEmits(['move-down', 'move-up', 'remove', 'retry']);

const COLORS = Object.freeze({
  flowDone: 'var(--ins-flow-done)',
  flowProgress: 'var(--ins-flow-progress)',
  flowReview: 'var(--ins-flow-review)',
  flowTodo: 'var(--ins-flow-todo)',
  muted: 'var(--ins-muted-series)',
  primary: 'var(--ins-series-1)',
  secondary: 'var(--ins-series-2)',
  tertiary: 'var(--ins-series-3)',
});
const SEVERITY_LABELS = { S1: 'S1 Critical', S2: 'S2 High', S3: 'S3 Medium', S4: 'S4 Low' };
const GANTT_COLUMNS = Object.freeze([
  { key: 'item', label: 'Item' },
  { key: 'assignee', label: 'Person' },
  { key: 'sprint', label: 'Sprint' },
  { key: 'start', label: 'Start' },
  { key: 'finish', label: 'Finish' },
  { key: 'days', label: 'Days', numeric: true },
  { key: 'placedBy', label: 'Starts then because' },
  { key: 'blockedBy', label: 'Blocked by' },
  { key: 'status', label: 'Status' },
  { key: 'flags', label: 'Flags' },
]);

const definition = computed(() => INSIGHTS_CARDS[props.type]);
const data = computed(() => props.card?.data ?? null);
const status = computed(() => (props.loading && !props.card ? 'loading' : props.card?.status ?? 'loading'));
const dataUnit = computed(() => data.value?.unit ?? props.unit);
const amount = (value) => withUnit(value, dataUnit.value);
const money = (value) => formatMoney(value, data.value?.currency ?? 'USD', { compact: true });

const title = computed(() => {
  if (props.type === 'sprint-burndown' && data.value?.sprint?.name) return `${data.value.sprint.name} burndown`;
  return definition.value.title;
});
const subtitle = computed(() => {
  const value = data.value;
  if (props.type === 'sprint-burndown' && value?.sprint) return `${formatDay(value.sprint.startDate)} – ${formatDay(value.sprint.endDate)} · ${amount(value.committed)} committed`;
  if (props.type === 'tickets-by-severity' && value) return `${value.open} open${value.medianAgeDays != null ? ` · median age ${formatNumber(value.medianAgeDays)} days` : ''}`;
  if (props.type === 'milestones' && value?.baseline) return `Baseline "${value.baseline.name}" · working days`;
  if (props.type === 'throughput' && value) return `Last ${value.days} days`;
  if (props.type === 'gantt' && value) return value.resources.length ? 'Each person works one open story at a time; blocking and sprints decide the earliest start' : definition.value.subtitle;
  return definition.value.subtitle ?? '';
});
const actionTo = computed(() => (props.card?.action ? actionLocation(props.card.action.target, props.projectId) : null));

const burnup = computed(() => {
  const value = data.value;
  if (props.type !== 'burnup' || !value) return null;
  const forecast = value.forecast?.date ? value.forecast : null;
  const current = value.series.at(-1);
  // With a forecast the axis runs to the latest likely finish (or the target), and scope is
  // held flat to it; without one the chart ends today.
  const endDate = forecast ? [value.today, forecast.latest, forecast.date, value.target].filter(Boolean).sort().at(-1) : value.today;
  const scopePoints = value.series.map((point) => ({ date: point.date, value: point.scope }));
  if (endDate > value.today) scopePoints.push({ date: endDate, value: current.scope });
  const series = [
    { color: COLORS.muted, endLabel: 'Scope', key: 'scope', label: 'Scope', points: scopePoints },
    { area: true, color: COLORS.primary, endLabel: 'Done', key: 'done', label: 'Done', points: value.series.map((point) => ({ date: point.date, value: point.done })) },
  ];
  let band = null;
  if (forecast) {
    series.push({ color: COLORS.primary, dashed: true, key: 'forecast', label: 'Forecast', points: [{ date: value.today, value: current.done }, { date: forecast.date, value: current.scope }] });
    if (forecast.earliest && forecast.latest && forecast.latest > forecast.earliest) {
      const span = Date.parse(forecast.latest) - Date.parse(value.today);
      const share = span > 0 ? (Date.parse(forecast.earliest) - Date.parse(value.today)) / span : 1;
      band = {
        color: COLORS.primary,
        label: 'Likely range',
        points: [
          { date: value.today, high: current.done, low: current.done },
          { date: forecast.earliest, high: current.scope, low: current.done + (current.scope - current.done) * share },
          { date: forecast.latest, high: current.scope, low: current.scope },
        ],
      };
    }
  }
  const markers = endDate > value.today ? [{ date: value.today, label: 'Today' }] : [];
  if (value.target && value.target <= endDate && value.target >= value.since) markers.push({ date: value.target, label: 'Target' });
  const rows = value.series.map((point) => ({ date: formatDay(point.date, { withYear: true }), done: formatNumber(point.done), key: point.date, scope: formatNumber(point.scope) }));
  if (forecast) rows.push({ date: `${formatDay(forecast.date, { withYear: true })} (forecast)`, done: formatNumber(current.scope), key: 'forecast', scope: formatNumber(current.scope) });
  const finish = forecast ? `likely ${formatDay(forecast.date)}` : 'no forecast yet';
  return {
    ariaLabel: `Burnup: ${amount(current.done)} done of ${amount(current.scope)} scope; ${finish}${value.target ? `, target ${formatDay(value.target)}` : ''}.`,
    band,
    endDate,
    markers,
    rows,
    series,
    startDate: value.since,
  };
});

const burndown = computed(() => {
  const value = data.value;
  if (props.type !== 'sprint-burndown' || !value) return null;
  return {
    ariaLabel: `${value.sprint.name} burndown: ${amount(value.remaining)} left of ${amount(value.committed)} committed.`,
    markers: value.today <= value.sprint.endDate ? [{ date: value.today, label: 'Today' }] : [],
    rows: value.dates.map((date) => {
      const point = value.series.find((entry) => entry.date === date);
      const ideal = value.ideal.find((entry) => entry.date === date);
      return { date: formatDay(date), ideal: formatNumber(ideal?.value), key: date, remaining: point ? formatNumber(point.remaining) : '—', scope: point ? formatNumber(point.scope) : '—' };
    }),
    series: [
      // Drawn straight from the first day to the last; the table keeps the per-day values.
      { color: COLORS.muted, key: 'ideal', label: 'Ideal', points: [value.ideal[0], value.ideal.at(-1)].filter(Boolean).map((point) => ({ date: point.date, value: point.value })) },
      { color: COLORS.primary, endLabel: 'Left', key: 'remaining', label: 'Remaining', points: value.series.map((point) => ({ date: point.date, value: point.remaining })) },
    ],
  };
});

const velocity = computed(() => {
  const value = data.value;
  if (props.type !== 'velocity' || !value) return null;
  return {
    ariaLabel: `Velocity over ${value.sprints.length} completed sprint${value.sprints.length === 1 ? '' : 's'}${value.summary ? `; average ${amount(value.summary.average)}` : ''}.`,
    categories: value.sprints.map((sprint) => ({ key: sprint.id, label: sprint.name })),
    reference: value.summary ? { label: `Average ${formatNumber(value.summary.average)}`, value: value.summary.average } : null,
    rows: value.sprints.map((sprint) => ({ committed: formatNumber(sprint.committed), completed: formatNumber(sprint.completed), key: sprint.id, sprint: sprint.name })),
    series: [
      { color: COLORS.muted, key: 'committed', label: 'Committed', values: value.sprints.map((sprint) => sprint.committed) },
      { color: COLORS.primary, key: 'completed', label: 'Completed', values: value.sprints.map((sprint) => sprint.completed) },
    ],
  };
});

const flow = computed(() => {
  const value = data.value;
  if (props.type !== 'cumulative-flow' || !value) return null;
  const pick = (key) => value.series.map((point) => point[key]);
  const last = value.series.at(-1);
  return {
    ariaLabel: `Cumulative flow: ${amount(last.done)} done, ${amount(last.review)} in review, ${amount(last.inProgress)} in progress, ${amount(last.notStarted)} not started.`,
    dates: value.series.map((point) => point.date),
    layers: [
      { color: COLORS.flowDone, key: 'done', label: 'Done', values: pick('done') },
      { color: COLORS.flowReview, key: 'review', label: 'In review', values: pick('review') },
      { color: COLORS.flowProgress, key: 'inProgress', label: 'In progress', values: pick('inProgress') },
      { color: COLORS.flowTodo, key: 'notStarted', label: 'Not started', values: pick('notStarted') },
    ],
    rows: value.series.map((point) => ({ date: formatDay(point.date, { withYear: true }), done: formatNumber(point.done), inProgress: formatNumber(point.inProgress), key: point.date, notStarted: formatNumber(point.notStarted), review: formatNumber(point.review) })),
  };
});

const ticketFlow = computed(() => {
  const value = data.value;
  if (props.type !== 'ticket-flow' || !value) return null;
  const opened = value.buckets.reduce((sum, row) => sum + row.opened, 0);
  const resolved = value.buckets.reduce((sum, row) => sum + row.resolved, 0);
  return {
    ariaLabel: `Ticket flow: ${opened} opened and ${resolved} resolved over ${value.buckets.length} periods.`,
    categories: value.buckets.map((row) => ({ key: row.start, label: formatDay(row.start) })),
    rows: value.buckets.map((row) => ({ key: row.start, opened: row.opened, resolved: row.resolved, week: `${formatDay(row.start)} – ${formatDay(row.end)}` })),
    series: [
      { color: COLORS.secondary, key: 'opened', label: 'Opened', values: value.buckets.map((row) => row.opened) },
      { color: COLORS.primary, key: 'resolved', label: 'Resolved', values: value.buckets.map((row) => row.resolved) },
    ],
  };
});

const severityRows = computed(() => (props.type === 'tickets-by-severity' && data.value
  ? data.value.bySeverity.map((row) => ({ key: row.severity, label: SEVERITY_LABELS[row.severity] ?? row.severity, value: row.count }))
  : []));

const earned = computed(() => {
  const value = data.value;
  if (props.type !== 'earned-value' || !value) return null;
  const line = (key) => value.series.map((point) => ({ date: point.date, value: point[key] }));
  const { kpis } = value;
  const ratio = (number) => (number == null ? '—' : Number(number).toFixed(2));
  return {
    ariaLabel: `Earned value in ${value.currency}: CPI ${ratio(kpis.cpi)}, SPI ${ratio(kpis.spi)}, estimate at completion ${money(kpis.eac)} against a budget of ${money(value.budget)}.`,
    kpis: `CPI ${ratio(kpis.cpi)} · SPI ${ratio(kpis.spi)} · EAC ${money(kpis.eac)} · budget ${money(value.budget)}`,
    rows: value.series.map((point) => ({ ac: money(point.ac), date: formatDay(point.date, { withYear: true }), ev: point.ev == null ? '—' : money(point.ev), key: point.date, pv: money(point.pv) })),
    series: [
      { color: COLORS.tertiary, key: 'pv', label: 'Planned value', points: line('pv') },
      { color: COLORS.primary, key: 'ev', label: 'Earned value', points: line('ev') },
      { color: COLORS.secondary, key: 'ac', label: 'Actual cost', points: line('ac') },
    ],
  };
});

const throughputRows = computed(() => (props.type === 'throughput' && data.value
  ? data.value.rows.map((row) => ({ detail: `${row.tasksCompleted} item${row.tasksCompleted === 1 ? '' : 's'}${row.hoursLogged ? ` · ${formatNumber(row.hoursLogged)}h` : ''}`, key: row.id, label: row.name, value: row.points }))
  : []));
</script>

<template>
  <InsightsCard
    :action="card?.action ?? null"
    :action-to="actionTo"
    :available-on="card?.availableOn ?? null"
    :bare="type === 'headline'"
    :can-move-down="canMoveDown"
    :can-move-up="canMoveUp"
    :card-id="`insights-card-${type}`"
    :editing="editing"
    :eyebrow="definition.eyebrow ?? ''"
    :help="definition.help"
    :message="card?.message ?? ''"
    :notes="card?.notes ?? []"
    :refreshing="refreshing"
    :size="definition.size"
    :status="status"
    :subtitle="subtitle"
    :table-available="!['headline', 'tickets-by-severity', 'throughput', 'saved-reports'].includes(type)"
    :title="title"
    @move-down="emit('move-down')"
    @move-up="emit('move-up')"
    @remove="emit('remove')"
    @retry="emit('retry')"
  >
    <template #default="{ showTable }">
      <InsightsHeadlineTiles v-if="type === 'headline'" :data="data" :unit="unit" />

      <template v-else-if="type === 'gantt' && data">
        <InsightsDataTable v-if="showTable" caption="Project timeline" :columns="GANTT_COLUMNS" :rows="ganttTableRows(data)" />
        <InsightsGanttChart v-else :data="data" :project-id="projectId" />
      </template>

      <template v-else-if="type === 'burnup' && burnup">
        <InsightsDataTable v-if="showTable" caption="Burnup data" :columns="[{ key: 'date', label: 'Date' }, { key: 'scope', label: 'Scope', numeric: true }, { key: 'done', label: 'Done', numeric: true }]" :rows="burnup.rows" />
        <InsightsLineChart v-else :aria-label="burnup.ariaLabel" :band="burnup.band" :end-date="burnup.endDate" :height="240" :markers="burnup.markers" :series="burnup.series" :start-date="burnup.startDate" :value-formatter="amount" />
      </template>

      <template v-else-if="type === 'sprint-burndown' && burndown">
        <InsightsDataTable v-if="showTable" :caption="`${title} data`" :columns="[{ key: 'date', label: 'Day' }, { key: 'scope', label: 'Scope', numeric: true }, { key: 'remaining', label: 'Remaining', numeric: true }, { key: 'ideal', label: 'Ideal', numeric: true }]" :rows="burndown.rows" />
        <InsightsLineChart v-else :aria-label="burndown.ariaLabel" :end-date="data.sprint.endDate" :markers="burndown.markers" :series="burndown.series" :start-date="data.sprint.startDate" :value-formatter="amount" />
        <ul v-if="data.scopeChanges.length" class="insights-card__changes">
          <li v-for="change in data.scopeChanges" :key="change.date">{{ change.delta > 0 ? '+' : '−' }}{{ amount(Math.abs(change.delta)) }} scope on {{ formatDay(change.date) }}</li>
        </ul>
      </template>

      <template v-else-if="type === 'velocity' && velocity">
        <InsightsDataTable v-if="showTable" caption="Velocity data" :columns="[{ key: 'sprint', label: 'Sprint' }, { key: 'committed', label: 'Committed', numeric: true }, { key: 'completed', label: 'Completed', numeric: true }]" :rows="velocity.rows" />
        <InsightsColumnChart v-else :aria-label="velocity.ariaLabel" :categories="velocity.categories" :reference="velocity.reference" :series="velocity.series" :value-formatter="amount" />
      </template>

      <template v-else-if="type === 'cumulative-flow' && flow">
        <InsightsDataTable v-if="showTable" caption="Cumulative flow data" :columns="[{ key: 'date', label: 'Date' }, { key: 'notStarted', label: 'Not started', numeric: true }, { key: 'inProgress', label: 'In progress', numeric: true }, { key: 'review', label: 'In review', numeric: true }, { key: 'done', label: 'Done', numeric: true }]" :rows="flow.rows" />
        <InsightsFlowChart v-else :aria-label="flow.ariaLabel" :dates="flow.dates" :layers="flow.layers" :value-formatter="amount" />
      </template>

      <template v-else-if="type === 'ticket-flow' && ticketFlow">
        <InsightsDataTable v-if="showTable" caption="Ticket flow data" :columns="[{ key: 'week', label: 'Period' }, { key: 'opened', label: 'Opened', numeric: true }, { key: 'resolved', label: 'Resolved', numeric: true }]" :rows="ticketFlow.rows" />
        <InsightsColumnChart v-else :aria-label="ticketFlow.ariaLabel" :categories="ticketFlow.categories" :series="ticketFlow.series" />
      </template>

      <InsightsBarList v-else-if="type === 'tickets-by-severity'" caption="Open tickets by severity" :rows="severityRows" />

      <template v-else-if="type === 'milestones' && data">
        <InsightsDataTable
          v-if="showTable"
          caption="Milestones against baseline"
          :columns="[{ key: 'title', label: 'Milestone' }, { key: 'reference', label: data.baseline ? 'Baseline' : 'Target' }, { key: 'forecast', label: 'Forecast' }, { key: 'variance', label: 'Variance (wd)', numeric: true }]"
          :rows="data.milestones.map((row) => ({ forecast: formatDay(row.forecastDate, { withYear: true }), key: row.id, reference: formatDay(row.baselineDate ?? row.targetDate, { withYear: true }), title: row.title, variance: row.varianceWorkingDays ?? '—' }))"
        />
        <InsightsMilestoneChart v-else :has-baseline="Boolean(data.baseline)" :milestones="data.milestones" :today="data.today" />
      </template>

      <template v-else-if="type === 'earned-value' && earned">
        <p class="insights-card__kpis">{{ earned.kpis }}</p>
        <InsightsDataTable v-if="showTable" :caption="`Earned value in ${data.currency}`" :columns="[{ key: 'date', label: 'Date' }, { key: 'pv', label: 'Planned value', numeric: true }, { key: 'ev', label: 'Earned value', numeric: true }, { key: 'ac', label: 'Actual cost', numeric: true }]" :rows="earned.rows" />
        <InsightsLineChart v-else :aria-label="earned.ariaLabel" :series="earned.series" :value-formatter="money" />
      </template>

      <template v-else-if="type === 'throughput' && data">
        <InsightsBarList :caption="`Points finished per person, last ${data.days} days`" :rows="throughputRows" :value-formatter="(value) => `${formatNumber(value)} ${unitLabel('points', value)}`" />
      </template>

      <InsightsSavedReports v-else-if="type === 'saved-reports' && data" :project-id="projectId" :reports="data.reports" />
    </template>

    <template v-if="type !== 'headline'" #footer>
      <span v-if="type === 'burnup' && data?.criticalPathForecast" class="insights-card__foot-note">Critical-path forecast (Governance): {{ formatDay(data.criticalPathForecast) }}</span>
      <span v-if="type === 'velocity' && data?.summary" class="insights-card__foot-note">Suggested commitment: {{ formatNumber(data.summary.min) }}–{{ formatNumber(data.summary.max) }} {{ unitLabel(dataUnit) }}</span>
      <span v-if="type === 'ticket-flow' && data" class="insights-card__foot-note">Opened exceeded resolved in {{ data.overflowWeeks }} of the last {{ data.recentCount }} periods</span>
      <span v-if="type === 'tickets-by-severity' && data" class="insights-card__foot-note">Reopened {{ data.reopened }} time{{ data.reopened === 1 ? '' : 's' }}</span>
      <span v-if="type === 'throughput' && data" class="insights-card__foot-note">{{ data.source === 'contributor-metrics' ? 'From leaderboard metrics' : 'From item history' }} · visible to everyone on the project</span>
      <span v-if="type === 'earned-value' && data?.otherCurrencies?.length" class="insights-card__foot-note">Also budgeted in {{ data.otherCurrencies.join(', ') }}</span>
      <span v-if="type === 'gantt' && data" class="insights-card__foot-note">{{ data.counts.links ? `${data.counts.links} blocking link${data.counts.links === 1 ? '' : 's'}` : 'No blocking links yet: add them in Governance or on a story' }}<template v-if="data.counts.noEstimate"> · {{ data.counts.noEstimate }} without an estimate</template></span>
      <RouterLink v-if="['sprint-burndown', 'velocity', 'gantt'].includes(type)" :to="{ name: 'project-sprints', params: { projectId } }">Open sprints</RouterLink>
      <RouterLink v-if="['ticket-flow', 'tickets-by-severity'].includes(type)" :to="{ name: 'project-tickets', params: { projectId } }">Open tickets</RouterLink>
      <RouterLink v-if="type === 'milestones'" :to="{ name: 'project-governance', params: { projectId } }">Open Governance</RouterLink>
      <RouterLink v-if="type === 'earned-value'" :to="{ name: 'finance' }">Open Finance</RouterLink>
      <RouterLink v-if="type === 'throughput'" :to="{ name: 'leaderboard' }">Open leaderboard</RouterLink>
      <RouterLink v-if="type === 'saved-reports'" :to="reportsLocation(projectId)">Manage in Reports</RouterLink>
    </template>
  </InsightsCard>
</template>
