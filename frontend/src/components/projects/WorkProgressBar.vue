<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue';

import { DEFAULT_ESTIMATE_HOURS, HOURS_PER_POINT } from '../../lib/projects/work-progress.js';

// Estimate-weighted progress bar. Hovering, focusing, or tapping it shows what each color
// stands for and how many hours and items sit behind it.
const props = defineProps({
  compact: {
    default: false,
    type: Boolean,
  },
  label: {
    default: 'Progress',
    type: String,
  },
  progress: {
    required: true,
    type: Object,
  },
});

const SHOW_DELAY_MS = 120;
const HIDE_DELAY_MS = 120;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

const tooltipId = `work-progress-tip-${useId()}`;
const open = ref(false);
const barRef = ref(null);
const tooltipRef = ref(null);
const tooltipPosition = ref({ left: 0, top: 0 });
let showTimer = null;
let hideTimer = null;

const hoursFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function formatHours(hours) {
  return `${hoursFormatter.format(hours)}h`;
}

function formatShare(share) {
  if (share > 0 && share < 1) return '<1%';
  return `${Math.round(share)}%`;
}

function itemCount(count) {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

const segments = computed(() => (props.progress?.buckets ?? []).filter((bucket) => bucket.hours > 0));
const hasWork = computed(() => (props.progress?.totalHours ?? 0) > 0);

const rows = computed(() => segments.value.map((bucket) => {
  if (bucket.key === 'done') {
    const inFlightHours = props.progress.inFlightEarnedHours;
    const parts = [];
    if (bucket.itemCount > 0) {
      parts.push(`${formatHours(bucket.hours - inFlightHours)} from ${bucket.itemCount} completed ${bucket.itemCount === 1 ? 'item' : 'items'}`);
    }
    if (inFlightHours > 0) parts.push(`${formatHours(inFlightHours)} earned on work in flight`);
    return { ...bucket, detail: parts.join(' + '), shareLabel: `${props.progress.percentComplete}%` };
  }

  const detail = bucket.key === 'backlog'
    ? `${formatHours(bucket.hours)} across ${itemCount(bucket.itemCount)}`
    : `${formatHours(bucket.hours)} left on ${itemCount(bucket.itemCount)}`;
  return { ...bucket, detail, shareLabel: formatShare(bucket.share) };
}));

const notes = computed(() => {
  const assumptions = props.progress?.assumptions ?? {};
  const result = [];
  if (assumptions.defaultEstimateCount > 0) {
    result.push(`${itemCount(assumptions.defaultEstimateCount)} without an estimate count as ${DEFAULT_ESTIMATE_HOURS}h.`);
  }
  if (assumptions.pointsEstimateCount > 0) {
    result.push(`${itemCount(assumptions.pointsEstimateCount)} estimated from points at ${HOURS_PER_POINT}h per point.`);
  }
  if (assumptions.defaultPercentCount > 0) {
    result.push(`${itemCount(assumptions.defaultPercentCount)} in flight without a % complete count as 50% done (80% in review).`);
  }
  return result;
});

const ariaLabel = computed(() => (hasWork.value
  ? `${props.label}: ${props.progress.percentComplete}% complete, ${formatHours(props.progress.earnedHours)} of ${formatHours(props.progress.totalHours)}`
  : `${props.label}: no work items yet`));

const tooltipStyle = computed(() => ({
  left: `${tooltipPosition.value.left}px`,
  top: `${tooltipPosition.value.top}px`,
}));

function clearTimers() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  showTimer = null;
  hideTimer = null;
}

function positionTooltip() {
  const bar = barRef.value;
  const tooltip = tooltipRef.value;
  if (!bar || !tooltip) return;

  const anchor = bar.getBoundingClientRect();
  const { height, width } = tooltip.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const below = anchor.bottom + ANCHOR_GAP;
  const above = anchor.top - ANCHOR_GAP - height;
  const top = below + height <= viewportHeight - VIEWPORT_MARGIN || above < VIEWPORT_MARGIN ? below : above;
  const left = Math.min(Math.max(anchor.left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN));

  tooltipPosition.value = { left, top };
}

function handleWindowKeydown(event) {
  if (event.key === 'Escape') hide();
}

let positionFrame = 0;

// Focusing a bar can scroll the outline to reveal it, so the tooltip follows its bar.
function schedulePosition() {
  if (positionFrame) return;
  positionFrame = requestAnimationFrame(() => {
    positionFrame = 0;
    positionTooltip();
  });
}

async function show() {
  clearTimers();
  if (open.value) return;

  open.value = true;
  window.addEventListener('scroll', schedulePosition, true);
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('keydown', handleWindowKeydown);
  await nextTick();

  const tooltip = tooltipRef.value;
  // A popover joins the top layer, so the tooltip escapes the outline's scroll container
  // and shows above open dialogs.
  if (typeof tooltip?.showPopover === 'function' && !tooltip.matches(':popover-open')) {
    tooltip.showPopover();
  }
  positionTooltip();
}

function hide() {
  clearTimers();
  if (!open.value) return;

  open.value = false;
  cancelAnimationFrame(positionFrame);
  positionFrame = 0;
  window.removeEventListener('scroll', schedulePosition, true);
  window.removeEventListener('resize', schedulePosition);
  window.removeEventListener('keydown', handleWindowKeydown);
}

function scheduleShow() {
  clearTimeout(hideTimer);
  hideTimer = null;
  if (!open.value && !showTimer) showTimer = setTimeout(show, SHOW_DELAY_MS);
}

function scheduleHide() {
  clearTimeout(showTimer);
  showTimer = null;
  if (open.value && !hideTimer) hideTimer = setTimeout(hide, HIDE_DELAY_MS);
}

onBeforeUnmount(hide);
</script>

<template>
  <div class="work-progress" :class="{ 'work-progress--compact': compact }">
    <button
      class="work-progress__trigger"
      type="button"
      :aria-describedby="open ? tooltipId : undefined"
      :aria-label="ariaLabel"
      @blur="hide"
      @click="show"
      @focus="show"
      @mouseenter="scheduleShow"
      @mouseleave="scheduleHide"
    >
      <span ref="barRef" class="status-progress work-progress__bar">
        <span
          v-for="segment in segments"
          :key="segment.key"
          class="status-progress__segment work-progress__segment"
          :class="segment.className"
          :style="{ flexGrow: segment.share }"
        ></span>
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        :id="tooltipId"
        ref="tooltipRef"
        class="work-progress-tip"
        popover="manual"
        role="tooltip"
        :style="tooltipStyle"
        @mouseenter="scheduleShow"
        @mouseleave="scheduleHide"
      >
        <template v-if="hasWork">
          <p class="work-progress-tip__headline">
            <strong>{{ progress.percentComplete }}% complete</strong>
            <span>{{ formatHours(progress.earnedHours) }} of {{ formatHours(progress.totalHours) }}</span>
          </p>
          <p v-if="progress.actual?.itemCount" class="work-progress-tip__actual">
            {{ formatHours(progress.actual.hours) }} actually spent, logged on {{ itemCount(progress.actual.itemCount) }}
          </p>
          <ul class="work-progress-tip__rows">
            <li v-for="row in rows" :key="row.key" class="work-progress-tip__row">
              <span class="work-progress-tip__swatch" :class="row.className" aria-hidden="true"></span>
              <span class="work-progress-tip__label">{{ row.label }}</span>
              <span class="work-progress-tip__share">{{ row.shareLabel }}</span>
              <span class="work-progress-tip__detail">{{ row.detail }}</span>
            </li>
          </ul>
          <p v-for="note in notes" :key="note" class="work-progress-tip__note">{{ note }}</p>
        </template>
        <p v-else class="work-progress-tip__note">No work items yet.</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* flow-root keeps the trigger's negative margins from collapsing into this margin. */
.work-progress {
  display: flow-root;
  margin-top: 0.9rem;
}

.work-progress--compact {
  margin: 0.4rem 0 0.25rem 2.25rem;
}

/* The padding widens the hover and tap area around the thin bar without moving the layout. */
.work-progress__trigger {
  display: block;
  width: 100%;
  margin: -0.4rem 0;
  padding: 0.4rem 0;
  border: 0;
  border-radius: 0.375rem;
  background: transparent;
  cursor: help;
}

.work-progress__trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.work-progress__bar {
  gap: 0;
  margin: 0;
}

.work-progress--compact .work-progress__bar {
  height: 0.34rem;
}

.work-progress__segment {
  flex: 0 1 0;
  min-width: 0.2rem;
}

.work-progress__segment + .work-progress__segment {
  box-shadow: inset 1px 0 0 var(--surface);
}
</style>

<style>
/* Teleported to the body, so these rules cannot be scoped. */
.work-progress-tip {
  position: fixed;
  inset: auto;
  z-index: 2050;
  width: max-content;
  max-width: min(22rem, calc(100vw - 1rem));
  margin: 0;
  padding: 0.75rem;
  overflow: visible;
  border: 1px solid var(--line-strong);
  border-radius: 0.5rem;
  background: var(--surface);
  color: var(--ink);
  box-shadow: var(--shadow);
  font-size: 0.8125rem;
  line-height: 1.25;
  animation: work-progress-tip-in 120ms ease-out;
}

.work-progress-tip[popover]:not(:popover-open) {
  display: none;
}

.work-progress-tip__headline {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin: 0 0 0.5rem;
}

.work-progress-tip__headline strong {
  font-size: 0.9375rem;
}

.work-progress-tip__headline span,
.work-progress-tip__actual,
.work-progress-tip__detail,
.work-progress-tip__note {
  color: var(--muted);
}

.work-progress-tip__actual {
  margin: -0.25rem 0 0.5rem;
  font-size: 0.75rem;
}

.work-progress-tip__rows {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0.5rem 0 0;
  border-top: 1px solid var(--line);
  list-style: none;
}

.work-progress-tip__row {
  display: grid;
  grid-template-columns: 0.625rem minmax(0, 1fr) auto;
  column-gap: 0.5rem;
  row-gap: 0.125rem;
  align-items: center;
}

.work-progress-tip__swatch {
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 0.1875rem;
}

.work-progress-tip__label {
  font-weight: 600;
}

.work-progress-tip__share {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.work-progress-tip__detail {
  grid-column: 2 / 4;
  font-size: 0.75rem;
}

.work-progress-tip__note {
  margin: 0.5rem 0 0;
  font-size: 0.75rem;
}

.work-progress-tip__rows + .work-progress-tip__note {
  padding-top: 0.5rem;
  border-top: 1px solid var(--line);
}

@keyframes work-progress-tip-in {
  from {
    opacity: 0;
    transform: translateY(-0.125rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .work-progress-tip {
    animation: none;
  }
}
</style>
