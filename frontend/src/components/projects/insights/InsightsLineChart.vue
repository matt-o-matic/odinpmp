<script setup>
import { computed, ref } from 'vue';

import { areaPath, dayMs, dayTicks, linePath, linearScale, niceTicks } from '../../../lib/insights/chart-geometry.js';
import { formatDay, formatNumber } from '../../../lib/insights/insights-format.js';
import { useChartHover, useElementWidth } from '../../../lib/insights/use-chart-frame.js';

// Lines over time on one axis. Series points are { date, value }; a null value breaks the
// line. `band` is an optional shaded range ({ date, low, high }); `markers` are labelled
// vertical rules such as Today and Target.

const props = defineProps({
  ariaLabel: { required: true, type: String },
  band: { default: null, type: Object },
  endDate: { default: '', type: String },
  height: { default: 220, type: Number },
  markers: { default: () => [], type: Array },
  series: { required: true, type: Array },
  startDate: { default: '', type: String },
  valueFormatter: { default: (value) => formatNumber(value), type: Function },
});

const frame = ref(null);
const width = useElementWidth(frame);
// End labels ("Scope 300 pts") sit right of the plot, so only charts with them reserve room.
const margin = {
  bottom: 28,
  left: 44,
  get right() { return props.series.some((entry) => entry.endLabel) ? 88 : 16; },
  top: 18,
};

// The crosshair stops where series have points; the band and markers only widen the axis.
const allDates = computed(() => {
  const dates = new Set();
  for (const entry of props.series) for (const point of entry.points) dates.add(point.date);
  return [...dates].sort();
});
const domain = computed(() => {
  const dates = [...allDates.value, ...(props.band?.points ?? []).map((point) => point.date), ...props.markers.map((marker) => marker.date)].filter(Boolean).sort();
  return { end: props.endDate || dates.at(-1), start: props.startDate || dates[0] };
});
const yAxis = computed(() => {
  const values = [];
  for (const entry of props.series) for (const point of entry.points) if (Number.isFinite(point.value)) values.push(point.value);
  for (const point of props.band?.points ?? []) values.push(point.high);
  return niceTicks(Math.max(0, ...values));
});
const x = computed(() => linearScale(dayMs(domain.value.start), dayMs(domain.value.end), margin.left, width.value - margin.right));
const y = computed(() => linearScale(0, yAxis.value.max, props.height - margin.bottom, margin.top));
const xTicks = computed(() => dayTicks(domain.value.start, domain.value.end, width.value < 420 ? 3 : 5));

const paths = computed(() => props.series.map((entry) => {
  const points = entry.points.map((point) => ({ x: x.value(dayMs(point.date)), y: point.value == null ? null : y.value(point.value) }));
  const last = [...points].reverse().find((point) => point.y != null);
  const lastValue = [...entry.points].reverse().find((point) => point.value != null)?.value;
  return { ...entry, area: entry.area ? areaPath(points, props.height - margin.bottom) : '', last, lastValue, line: linePath(points) };
}));
const bandPath = computed(() => {
  const points = props.band?.points ?? [];
  if (points.length < 2) return '';
  return areaPath(points.map((point) => ({ x: x.value(dayMs(point.date)), y: y.value(point.high) })), points.map((point) => ({ x: x.value(dayMs(point.date)), y: y.value(point.low) })));
});

const hover = useChartHover(() => allDates.value.map((date) => x.value(dayMs(date))));
const active = computed(() => {
  const date = allDates.value[hover.activeIndex.value];
  if (!date) return null;
  const values = props.series
    .map((entry) => ({ color: entry.color, key: entry.key, label: entry.label, point: entry.points.find((point) => point.date === date) }))
    .filter((entry) => entry.point && entry.point.value != null);
  return { date, values, x: x.value(dayMs(date)) };
});
const tooltipLeft = computed(() => Math.max(0, Math.min(width.value - 190, (active.value?.x ?? 0) + 12)));
const liveSummary = computed(() => (active.value ? `${formatDay(active.value.date)}: ${active.value.values.map((entry) => `${entry.label} ${props.valueFormatter(entry.point.value)}`).join(', ')}` : ''));
</script>

<template>
  <figure class="insights-chart">
    <ul v-if="series.length > 1 || band" class="insights-chart__legend" aria-hidden="true">
      <li v-for="entry in series" :key="entry.key">
        <span class="insights-chart__key" :class="{ 'insights-chart__key--dashed': entry.dashed }" :style="{ '--key-color': entry.color }"></span>{{ entry.label }}
      </li>
      <li v-if="band"><span class="insights-chart__key insights-chart__key--band" :style="{ '--key-color': band.color }"></span>{{ band.label }}</li>
    </ul>
    <div
      ref="frame"
      class="insights-chart__plot"
      role="img"
      tabindex="0"
      :aria-label="ariaLabel"
      @blur="hover.onBlur"
      @keydown="hover.onKeydown"
      @pointerleave="hover.onPointerLeave"
      @pointermove="hover.onPointerMove"
    >
      <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" aria-hidden="true" focusable="false">
        <g class="insights-chart__grid">
          <template v-for="tick in yAxis.ticks" :key="`y-${tick}`">
            <line :x1="margin.left" :x2="width - margin.right" :y1="y(tick)" :y2="y(tick)" />
            <text :x="margin.left - 6" :y="y(tick) + 4" text-anchor="end">{{ formatNumber(tick, { compact: true }) }}</text>
          </template>
          <text v-for="tick in xTicks" :key="`x-${tick}`" :x="x(dayMs(tick))" :y="height - 8" text-anchor="middle">{{ formatDay(tick) }}</text>
        </g>
        <path v-if="bandPath" class="insights-chart__band" :d="bandPath" :style="{ fill: band.color }" />
        <path v-for="entry in paths" v-show="entry.area" :key="`area-${entry.key}`" class="insights-chart__area" :d="entry.area" :style="{ fill: entry.color }" />
        <g v-for="marker in markers" :key="`marker-${marker.label}`" class="insights-chart__marker">
          <line :x1="x(dayMs(marker.date))" :x2="x(dayMs(marker.date))" :y1="margin.top" :y2="height - margin.bottom" />
          <text :x="x(dayMs(marker.date))" :y="margin.top - 5" text-anchor="middle">{{ marker.label }}</text>
        </g>
        <path
          v-for="entry in paths"
          :key="`line-${entry.key}`"
          class="insights-chart__line"
          :class="{ 'insights-chart__line--dashed': entry.dashed }"
          :d="entry.line"
          :style="{ stroke: entry.color }"
        />
        <template v-for="entry in paths" :key="`end-${entry.key}`">
          <g v-if="entry.endLabel && entry.last">
            <circle class="insights-chart__dot" :cx="entry.last.x" :cy="entry.last.y" r="4" :style="{ fill: entry.color }" />
            <text class="insights-chart__end" :x="entry.last.x + 8" :y="entry.last.y + 4">{{ entry.endLabel }} {{ valueFormatter(entry.lastValue) }}</text>
          </g>
        </template>
        <g v-if="active" class="insights-chart__hover">
          <line :x1="active.x" :x2="active.x" :y1="margin.top" :y2="height - margin.bottom" />
          <circle v-for="entry in active.values" :key="`hover-${entry.key}`" class="insights-chart__dot" :cx="active.x" :cy="y(entry.point.value)" r="4" :style="{ fill: entry.color }" />
        </g>
      </svg>
      <div v-if="active" class="insights-chart__tooltip" :style="{ left: `${tooltipLeft}px` }" aria-hidden="true">
        <strong>{{ formatDay(active.date, { withYear: true }) }}</strong>
        <span v-for="entry in active.values" :key="`tip-${entry.key}`"><i :style="{ background: entry.color }"></i>{{ entry.label }} {{ valueFormatter(entry.point.value) }}</span>
      </div>
    </div>
    <p class="visually-hidden" aria-live="polite">{{ liveSummary }}</p>
  </figure>
</template>
