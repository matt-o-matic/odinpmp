<script setup>
import { computed } from 'vue';

import { dayMs, dayTicks } from '../../../lib/insights/chart-geometry.js';
import { formatDay } from '../../../lib/insights/insights-format.js';

// A dumbbell per milestone: its baseline (or target) date to its forecast, with the variance
// in working days printed beside it.

const props = defineProps({
  hasBaseline: { default: false, type: Boolean },
  milestones: { required: true, type: Array },
  today: { required: true, type: String },
});

const domain = computed(() => {
  const dates = props.milestones.flatMap((row) => [row.baselineDate, row.targetDate, row.forecastDate]).filter(Boolean);
  dates.push(props.today);
  const sorted = [...new Set(dates)].sort();
  const start = dayMs(sorted[0]);
  const end = Math.max(dayMs(sorted.at(-1)), start + 7 * 86_400_000);
  return { end, start };
});
const position = (date) => `${(((dayMs(date) - domain.value.start) / (domain.value.end - domain.value.start)) * 100).toFixed(2)}%`;
const ticks = computed(() => dayTicks(new Date(domain.value.start).toISOString(), new Date(domain.value.end).toISOString(), 4));

function variance(row) {
  if (row.varianceWorkingDays == null) return '';
  const value = Number(row.varianceWorkingDays);
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return `${sign}${Math.abs(value)} wd`;
}

function rowLabel(row) {
  const reference = row.baselineDate ?? row.targetDate;
  const parts = [`${row.title}: ${props.hasBaseline && row.baselineDate ? 'baseline' : 'target'} ${formatDay(reference)}`, `forecast ${formatDay(row.forecastDate)}`];
  if (row.varianceWorkingDays) parts.push(`${Math.abs(row.varianceWorkingDays)} working days ${row.varianceWorkingDays > 0 ? 'late' : 'early'}`);
  if (row.status === 'achieved') parts.push('achieved');
  return parts.join(', ');
}
</script>

<template>
  <div class="insights-milestones">
    <ul class="insights-chart__legend" aria-hidden="true">
      <li><span class="insights-milestones__dot insights-milestones__dot--reference"></span>{{ hasBaseline ? 'Baseline' : 'Target' }}</li>
      <li><span class="insights-milestones__dot"></span>Forecast or actual</li>
    </ul>
    <ol class="insights-milestones__rows">
      <li v-for="row in milestones" :key="row.id" class="insights-milestones__row">
        <span class="visually-hidden">{{ rowLabel(row) }}</span>
        <span class="insights-milestones__title" aria-hidden="true">{{ row.title }}</span>
        <span class="insights-milestones__track" aria-hidden="true">
          <span
            v-if="(row.baselineDate ?? row.targetDate) && row.forecastDate"
            class="insights-milestones__span"
            :style="{ left: position([row.baselineDate ?? row.targetDate, row.forecastDate].sort()[0]), right: `calc(100% - ${position([row.baselineDate ?? row.targetDate, row.forecastDate].sort()[1])})` }"
          ></span>
          <span v-if="row.baselineDate ?? row.targetDate" class="insights-milestones__dot insights-milestones__dot--reference" :style="{ left: position(row.baselineDate ?? row.targetDate) }"></span>
          <span v-if="row.forecastDate" class="insights-milestones__dot" :style="{ left: position(row.forecastDate) }"></span>
        </span>
        <span class="insights-milestones__variance" :class="{ 'insights-milestones__variance--late': row.varianceWorkingDays > 0 }" aria-hidden="true">
          {{ variance(row) }}<template v-if="row.status === 'achieved'"> · done</template>
        </span>
      </li>
    </ol>
    <div class="insights-milestones__row insights-milestones__row--axis" aria-hidden="true">
      <span></span>
      <span class="insights-milestones__axis">
        <span v-for="tick in ticks" :key="tick" :style="{ left: position(tick) }">{{ formatDay(tick) }}</span>
      </span>
      <span></span>
    </div>
  </div>
</template>
