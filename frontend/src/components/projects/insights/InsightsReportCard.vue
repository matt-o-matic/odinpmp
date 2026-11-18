<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import InsightsBarList from './InsightsBarList.vue';
import InsightsCard from './InsightsCard.vue';
import InsightsDataTable from './InsightsDataTable.vue';
import { apiClient } from '../../../lib/auth/index.js';
import { VISUALIZATION_LABELS, formatDateTime, formatNumber, reportsLocation } from '../../../lib/insights/insights-format.js';

// A saved report shown as a card. It loads on its own: the server answers from the viewer's
// latest run, refreshing it in the background when it is stale, so there is no Run button.

const props = defineProps({
  canMoveDown: { default: false, type: Boolean },
  canMoveUp: { default: false, type: Boolean },
  editing: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  refreshVersion: { default: 0, type: Number },
  reportId: { required: true, type: String },
  token: { default: '', type: String },
});

const emit = defineEmits(['move-down', 'move-up', 'remove']);

const POLL_MS = 4000;
const MAX_POLLS = 8;
const PREVIEW_ROWS = 8;

const result = ref(null);
const failure = ref(null);
const loading = ref(false);
let sequence = 0;
let pollTimer = null;
let polls = 0;

function clearPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

async function load({ background = false } = {}) {
  const current = ++sequence;
  clearPoll();
  if (!background) {
    loading.value = true;
    polls = 0;
  }
  try {
    const response = await apiClient.passive.getProjectInsightsReportCard(props.projectId, props.reportId, props.token);
    if (current !== sequence) return;
    result.value = response;
    failure.value = null;
    if (response.refreshing && polls < MAX_POLLS) {
      polls += 1;
      pollTimer = setTimeout(() => load({ background: true }), POLL_MS);
    }
  } catch (error) {
    if (current !== sequence) return;
    failure.value = { message: error.message ?? 'This report could not be loaded.', status: error.status ?? 500 };
  } finally {
    if (current === sequence) loading.value = false;
  }
}

watch(() => [props.reportId, props.refreshVersion], () => load(), { immediate: true });
onBeforeUnmount(() => {
  sequence += 1;
  clearPoll();
});

const report = computed(() => result.value?.report ?? null);
const title = computed(() => report.value?.name ?? 'Saved report');
const status = computed(() => {
  if (failure.value?.status === 404) return 'empty';
  if (failure.value) return 'error';
  if (!result.value) return 'loading';
  if (result.value.cache === 'inactive' || result.value.rowCount === 0) return 'empty';
  return 'ready';
});
const message = computed(() => {
  if (failure.value?.status === 404) return 'This report was deleted or is not shared with you.';
  if (failure.value) return 'This report could not be run. Other cards are unaffected.';
  if (result.value?.cache === 'inactive') return 'This report is turned off. Turn it on in Reports to show it here.';
  if (result.value?.rowCount === 0) return 'The report ran and returned no rows.';
  return '';
});
const refreshing = computed(() => Boolean(result.value?.refreshing) || (loading.value && Boolean(result.value)));

const columns = computed(() => (report.value?.columns ?? []).map((key) => ({ key, label: key, numeric: false })));
const rows = computed(() => result.value?.rows ?? []);
const numericColumns = computed(() => columns.value.filter((column) => rows.value.length > 0 && rows.value.every((row) => row[column.key] == null || typeof row[column.key] === 'number')).map((column) => column.key));
const tableColumns = computed(() => columns.value.map((column) => ({ ...column, numeric: numericColumns.value.includes(column.key) })));
const tableRows = computed(() => rows.value.slice(0, PREVIEW_ROWS).map((row, index) => ({ key: index, ...Object.fromEntries(columns.value.map((column) => [column.key, Array.isArray(row[column.key]) ? row[column.key].join(', ') : row[column.key]])) })));

const barRows = computed(() => {
  const labelKey = columns.value.find((column) => !numericColumns.value.includes(column.key))?.key ?? columns.value[0]?.key;
  const valueKey = numericColumns.value[0];
  if (!labelKey) return [];
  if (valueKey) return rows.value.slice(0, PREVIEW_ROWS).map((row, index) => ({ key: `${index}`, label: String(row[labelKey] ?? '—'), value: Number(row[valueKey] ?? 0) }));
  const counts = new Map();
  for (const row of rows.value) counts.set(String(row[labelKey] ?? '—'), (counts.get(String(row[labelKey] ?? '—')) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, PREVIEW_ROWS).map(([label, value]) => ({ key: label, label, value }));
});
const barCaption = computed(() => {
  const valueKey = numericColumns.value[0];
  return valueKey ? `${title.value}: ${valueKey} by row` : `${title.value}: rows by ${columns.value.find((column) => !numericColumns.value.includes(column.key))?.key ?? 'value'}`;
});
const summaryTiles = computed(() => [
  { key: 'rows', label: 'Rows', value: formatNumber(result.value?.rowCount ?? 0) },
  ...numericColumns.value.slice(0, 3).map((key) => ({ key, label: `Total ${key}`, value: formatNumber(rows.value.reduce((sum, row) => sum + (Number(row[key]) || 0), 0), { compact: true }) })),
]);
const visualization = computed(() => report.value?.visualization ?? 'table');
const subtitle = computed(() => (report.value ? `${report.value.dataset.replaceAll('_', ' ')} · ${VISUALIZATION_LABELS[visualization.value] ?? visualization.value}` : ''));
</script>

<template>
  <InsightsCard
    :action="status === 'empty' ? { label: 'Open Reports', target: 'reports' } : null"
    :action-to="reportsLocation(projectId)"
    :can-move-down="canMoveDown"
    :can-move-up="canMoveUp"
    :card-id="`insights-card-report-${reportId}`"
    :editing="editing"
    eyebrow="Saved report"
    :help="report?.description || 'A saved report from Reports. It runs on its own and refreshes when its results are more than 15 minutes old.'"
    :message="message"
    :refreshing="refreshing"
    size="half"
    :status="status"
    :subtitle="subtitle"
    :table-available="visualization !== 'table'"
    :title="title"
    @move-down="emit('move-down')"
    @move-up="emit('move-up')"
    @remove="emit('remove')"
    @retry="load()"
  >
    <template #default="{ showTable }">
      <InsightsDataTable v-if="visualization === 'table' || showTable" :caption="`${title} results`" :columns="tableColumns" :rows="tableRows" />
      <ul v-else-if="visualization === 'summary'" class="insights-tiles insights-tiles--compact">
        <li v-for="tile in summaryTiles" :key="tile.key" class="insights-tile">
          <p class="insights-tile__label">{{ tile.label }}</p>
          <p class="insights-tile__value">{{ tile.value }}</p>
        </li>
      </ul>
      <InsightsBarList v-else :caption="barCaption" :rows="barRows" />
    </template>
    <template #footer>
      <span class="insights-card__foot-note">
        {{ result?.rowCount > PREVIEW_ROWS && (visualization === 'table' || visualization === 'bar' || visualization === 'line' || visualization === 'pie') ? `Showing ${PREVIEW_ROWS} of ${result.rowCount}${result.truncated ? '+' : ''} rows · ` : '' }}As of {{ formatDateTime(result?.asOf) }}
      </span>
      <RouterLink :to="reportsLocation(projectId)">Open in Reports</RouterLink>
    </template>
  </InsightsCard>
</template>
