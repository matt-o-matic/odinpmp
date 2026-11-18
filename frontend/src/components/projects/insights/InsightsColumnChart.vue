<script setup>
import { computed, ref } from 'vue';

import { columnPath, linearScale, niceTicks } from '../../../lib/insights/chart-geometry.js';
import { formatNumber } from '../../../lib/insights/insights-format.js';
import { useChartHover, useElementWidth } from '../../../lib/insights/use-chart-frame.js';

// Grouped columns per category on one axis, with an optional labelled reference line.

const props = defineProps({
  ariaLabel: { required: true, type: String },
  categories: { required: true, type: Array },
  height: { default: 220, type: Number },
  reference: { default: null, type: Object },
  series: { required: true, type: Array },
  valueFormatter: { default: (value) => formatNumber(value), type: Function },
});

const MAX_BAR = 16;
const GAP = 2;
const frame = ref(null);
const width = useElementWidth(frame);
const margin = { bottom: 28, left: 40, right: 12, top: 14 };

const yAxis = computed(() => niceTicks(Math.max(0, ...props.series.flatMap((entry) => entry.values), props.reference?.value ?? 0)));
const y = computed(() => linearScale(0, yAxis.value.max, props.height - margin.bottom, margin.top));
const band = computed(() => (width.value - margin.left - margin.right) / Math.max(1, props.categories.length));
const barWidth = computed(() => Math.max(3, Math.min(MAX_BAR, (band.value * 0.7 - GAP * (props.series.length - 1)) / Math.max(1, props.series.length))));
const groupWidth = computed(() => barWidth.value * props.series.length + GAP * (props.series.length - 1));
const centers = computed(() => props.categories.map((_, index) => margin.left + band.value * (index + 0.5)));
const labelEvery = computed(() => Math.max(1, Math.ceil(props.categories.length / Math.max(1, Math.floor((width.value - margin.left) / 56)))));

const bars = computed(() => props.categories.flatMap((category, index) => props.series.map((entry, position) => {
  const value = Number(entry.values[index] ?? 0);
  const left = centers.value[index] - groupWidth.value / 2 + position * (barWidth.value + GAP);
  return { color: entry.color, d: columnPath(left, barWidth.value, y.value(value), props.height - margin.bottom), key: `${category.key}-${entry.key}` };
})));

const hover = useChartHover(() => centers.value);
const active = computed(() => {
  const index = hover.activeIndex.value;
  const category = props.categories[index];
  if (!category) return null;
  return { category, values: props.series.map((entry) => ({ color: entry.color, key: entry.key, label: entry.label, value: entry.values[index] ?? 0 })), x: centers.value[index] };
});
const tooltipLeft = computed(() => Math.max(0, Math.min(width.value - 190, (active.value?.x ?? 0) + 12)));
const liveSummary = computed(() => (active.value ? `${active.value.category.label}: ${active.value.values.map((entry) => `${entry.label} ${props.valueFormatter(entry.value)}`).join(', ')}` : ''));
</script>

<template>
  <figure class="insights-chart">
    <ul v-if="series.length > 1 || reference" class="insights-chart__legend" aria-hidden="true">
      <li v-for="entry in series" :key="entry.key"><span class="insights-chart__key insights-chart__key--block" :style="{ '--key-color': entry.color }"></span>{{ entry.label }}</li>
      <li v-if="reference"><span class="insights-chart__key insights-chart__key--reference"></span>{{ reference.label }}</li>
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
          <template v-for="(category, index) in categories" :key="`x-${category.key}`">
            <text v-if="(categories.length - 1 - index) % labelEvery === 0" :x="centers[index]" :y="height - 8" text-anchor="middle">{{ category.label }}</text>
          </template>
        </g>
        <rect v-if="active" class="insights-chart__hover-band" :x="active.x - band / 2" :y="margin.top" :width="band" :height="height - margin.top - margin.bottom" />
        <path v-for="bar in bars" v-show="bar.d" :key="bar.key" :d="bar.d" :style="{ fill: bar.color }" />
        <g v-if="reference" class="insights-chart__reference">
          <line :x1="margin.left" :x2="width - margin.right" :y1="y(reference.value)" :y2="y(reference.value)" />
        </g>
      </svg>
      <div v-if="active" class="insights-chart__tooltip" :style="{ left: `${tooltipLeft}px` }" aria-hidden="true">
        <strong>{{ active.category.label }}</strong>
        <span v-for="entry in active.values" :key="`tip-${entry.key}`"><i :style="{ background: entry.color }"></i>{{ entry.label }} {{ valueFormatter(entry.value) }}</span>
      </div>
    </div>
    <p class="visually-hidden" aria-live="polite">{{ liveSummary }}</p>
  </figure>
</template>
