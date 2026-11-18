<script setup>
import { computed, ref } from 'vue';

import { areaPath, dayMs, dayTicks, linePath, linearScale, niceTicks } from '../../../lib/insights/chart-geometry.js';
import { formatDay, formatNumber } from '../../../lib/insights/insights-format.js';
import { useChartHover, useElementWidth } from '../../../lib/insights/use-chart-frame.js';

// Stacked areas over time (cumulative flow). `layers` stack bottom first; each layer's top
// edge carries a 2px surface-coloured rule so neighbouring steps of the ramp stay distinct.

const props = defineProps({
  ariaLabel: { required: true, type: String },
  dates: { required: true, type: Array },
  height: { default: 220, type: Number },
  layers: { required: true, type: Array },
  valueFormatter: { default: (value) => formatNumber(value), type: Function },
});

const frame = ref(null);
const width = useElementWidth(frame);
const margin = { bottom: 28, left: 44, right: 12, top: 14 };

const stacks = computed(() => {
  let running = props.dates.map(() => 0);
  return props.layers.map((layer) => {
    const lower = running;
    const upper = running.map((value, index) => value + Number(layer.values[index] ?? 0));
    running = upper;
    return { ...layer, lower, upper };
  });
});
const yAxis = computed(() => niceTicks(Math.max(0, ...(stacks.value.at(-1)?.upper ?? [0]))));
const x = computed(() => linearScale(dayMs(props.dates[0]), dayMs(props.dates.at(-1)), margin.left, width.value - margin.right));
const y = computed(() => linearScale(0, yAxis.value.max, props.height - margin.bottom, margin.top));
const xTicks = computed(() => dayTicks(props.dates[0], props.dates.at(-1), width.value < 420 ? 3 : 5));
const shapes = computed(() => stacks.value.map((layer) => {
  const upper = props.dates.map((date, index) => ({ x: x.value(dayMs(date)), y: y.value(layer.upper[index]) }));
  const lower = props.dates.map((date, index) => ({ x: x.value(dayMs(date)), y: y.value(layer.lower[index]) }));
  return { area: areaPath(upper, lower), color: layer.color, edge: linePath(upper), key: layer.key };
}));

const hover = useChartHover(() => props.dates.map((date) => x.value(dayMs(date))));
const active = computed(() => {
  const index = hover.activeIndex.value;
  const date = props.dates[index];
  if (!date) return null;
  return { date, values: [...props.layers].reverse().map((layer) => ({ color: layer.color, key: layer.key, label: layer.label, value: layer.values[index] ?? 0 })), x: x.value(dayMs(date)) };
});
const tooltipLeft = computed(() => Math.max(0, Math.min(width.value - 190, (active.value?.x ?? 0) + 12)));
const liveSummary = computed(() => (active.value ? `${formatDay(active.value.date)}: ${active.value.values.map((entry) => `${entry.label} ${props.valueFormatter(entry.value)}`).join(', ')}` : ''));
</script>

<template>
  <figure class="insights-chart">
    <ul class="insights-chart__legend" aria-hidden="true">
      <li v-for="layer in [...layers].reverse()" :key="layer.key"><span class="insights-chart__key insights-chart__key--block" :style="{ '--key-color': layer.color }"></span>{{ layer.label }}</li>
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
        <path v-for="shape in shapes" :key="`area-${shape.key}`" :d="shape.area" :style="{ fill: shape.color }" />
        <path v-for="shape in shapes" :key="`edge-${shape.key}`" class="insights-chart__gap" :d="shape.edge" />
        <line v-if="active" class="insights-chart__hover-rule" :x1="active.x" :x2="active.x" :y1="margin.top" :y2="height - margin.bottom" />
      </svg>
      <div v-if="active" class="insights-chart__tooltip" :style="{ left: `${tooltipLeft}px` }" aria-hidden="true">
        <strong>{{ formatDay(active.date, { withYear: true }) }}</strong>
        <span v-for="entry in active.values" :key="`tip-${entry.key}`"><i :style="{ background: entry.color }"></i>{{ entry.label }} {{ valueFormatter(entry.value) }}</span>
      </div>
    </div>
    <p class="visually-hidden" aria-live="polite">{{ liveSummary }}</p>
  </figure>
</template>
