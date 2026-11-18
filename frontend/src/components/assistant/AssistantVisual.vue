<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';

import { chartConfigFor, chartTable, nextZoomStep, parseChartSpec, sanitizeGraphvizSvg, svgNaturalSize, ZOOM_STEPS } from '../../lib/assistant/assistant-visuals.js';
import { mermaidErrorText, renderMermaid } from '../../lib/requirements/requirements-mermaid.js';
import { focusOrigin } from '../../lib/ui/focus-origin.js';
import AssistantTypingDots from './AssistantTypingDots.vue';

// One visual in a reply: a chart (Chart.js), a diagram (Mermaid) or a graph (Graphviz), each
// loaded on first use and redrawn when the theme changes. "Show data" or "Show source" opens
// the numbers or the code behind it; "Enlarge" opens it in a zoomable view over the page.
const props = defineProps({ visual: { required: true, type: Object } });

const PENDING_LABELS = { chart: 'Drawing a chart', graphviz: 'Drawing a graph', mermaid: 'Drawing a diagram' };
const canvas = ref(null);
const diagram = ref(null);
const error = ref('');
const showDetails = ref(false);
const dark = ref(false);
let chart = null;
let observer = null;
let vizInstance = null;

const parsed = computed(() => (props.visual.type === 'chart' && !props.visual.pending ? parseChartSpec(props.visual.source) : null));
const table = computed(() => (parsed.value?.spec ? chartTable(parsed.value.spec) : null));
const chartHeight = computed(() => {
  const spec = parsed.value?.spec;
  if (!spec) return 280;
  if (spec.type === 'horizontal-bar') return Math.min(560, Math.max(200, spec.labels.length * 32 + 80));
  return 300;
});
const label = computed(() => parsed.value?.spec?.title || { chart: 'Chart', graphviz: 'Graph', mermaid: 'Diagram' }[props.visual.type]);

// Draws the chart on the canvas the getter returns once Chart.js has loaded.
async function chartInto(getCanvas) {
  const { default: Chart } = await import('chart.js/auto');
  await nextTick();
  const target = getCanvas();
  return target ? new Chart(target, chartConfigFor(parsed.value.spec, { dark: dark.value })) : null;
}

async function diagramInto(element) {
  if (props.visual.type === 'mermaid') {
    element.innerHTML = await renderMermaid(props.visual.source, { dark: dark.value });
    return;
  }
  if (!vizInstance) vizInstance = await (await import('@viz-js/viz')).instance();
  const ink = dark.value ? '#c4d2e8' : '#13233a';
  const svg = vizInstance.renderSVGElement(props.visual.source, {
    edgeAttributes: { color: ink, fontcolor: ink, fontname: 'Helvetica' },
    graphAttributes: { bgcolor: 'transparent', fontcolor: ink, fontname: 'Helvetica' },
    nodeAttributes: { color: ink, fontcolor: ink, fontname: 'Helvetica' },
  });
  element.replaceChildren(sanitizeGraphvizSvg(svg));
}

function drawError(caught) {
  if (props.visual.type === 'mermaid') return mermaidErrorText(caught) || 'Mermaid could not draw it.';
  return String(caught?.message ?? 'Graphviz could not draw it.').split('\n')[0].slice(0, 200);
}

async function draw() {
  error.value = '';
  chart?.destroy();
  chart = null;
  if (props.visual.pending) return;
  if (props.visual.type === 'chart' && !parsed.value?.spec) {
    error.value = parsed.value?.error ?? 'The chart could not be read.';
    return;
  }
  await nextTick();
  try {
    if (props.visual.type === 'chart') chart = await chartInto(() => canvas.value);
    else if (diagram.value) await diagramInto(diagram.value);
  } catch (caught) {
    error.value = drawError(caught);
  }
  if (zoomOpen.value) await drawZoomed();
}

// The zoomed view: a modal <dialog> sized to the window. Zoom is relative to "fit": a diagram
// fits the window at 100%, a chart fills it. Buttons, Ctrl or Cmd with the wheel, and + - 0
// change it; drag or scroll to pan.
const zoomTitleId = useId();
const zoomOpen = ref(false);
const zoomDialog = ref(null);
const zoomStage = ref(null);
const zoomCanvas = ref(null);
const zoomDiagram = ref(null);
const zoom = ref(1);
const natural = ref(null);
const stage = ref({ height: 0, width: 0 });
let zoomChart = null;
let zoomOpener = null;
let stageObserver = null;
let pan = null;

const fit = computed(() => (natural.value && stage.value.width ? Math.min(stage.value.width / natural.value.width, stage.value.height / natural.value.height, 3) : 1));
const zoomContentStyle = computed(() => {
  if (props.visual.type === 'chart') return { height: `${Math.max(240, stage.value.height * zoom.value)}px`, width: `${Math.max(320, stage.value.width * zoom.value)}px` };
  return natural.value ? { width: `${natural.value.width * fit.value * zoom.value}px` } : {};
});
const zoomLabel = computed(() => (zoom.value === 1 ? 'Fit' : `${Math.round(zoom.value * 100)}%`));

async function drawZoomed() {
  zoomChart?.destroy();
  zoomChart = null;
  await nextTick();
  try {
    if (props.visual.type === 'chart') {
      zoomChart = await chartInto(() => zoomCanvas.value);
    } else if (zoomDiagram.value) {
      await diagramInto(zoomDiagram.value);
      natural.value = svgNaturalSize(zoomDiagram.value.querySelector('svg'));
    }
  } catch {
    // The reply already drew it once; a failed redraw leaves the last picture in place.
  }
}

function measureStage() {
  const element = zoomStage.value;
  if (!element) return;
  const styles = getComputedStyle(element);
  const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  stage.value = { height: Math.max(0, element.clientHeight - padY), width: Math.max(0, element.clientWidth - padX) };
}

async function openZoom() {
  zoomOpener = focusOrigin();
  zoom.value = 1;
  natural.value = null;
  zoomOpen.value = true;
  await nextTick();
  zoomDialog.value?.showModal?.();
  measureStage();
  stageObserver = new ResizeObserver(measureStage);
  if (zoomStage.value) stageObserver.observe(zoomStage.value);
  zoomDialog.value?.querySelector('.assistant-zoom__close')?.focus();
  await drawZoomed();
}

function closeZoom() {
  stageObserver?.disconnect();
  stageObserver = null;
  zoomChart?.destroy();
  zoomChart = null;
  if (zoomDialog.value?.open) zoomDialog.value.close();
  zoomOpen.value = false;
  const target = zoomOpener;
  zoomOpener = null;
  if (target && document.contains(target)) target.focus?.();
}

// Zooms one step in or out (or back to fit), keeping the middle of the view in place.
async function setZoom(next) {
  const element = zoomStage.value;
  if (!element || next === zoom.value) return;
  const centerX = (element.scrollLeft + element.clientWidth / 2) / Math.max(1, element.scrollWidth);
  const centerY = (element.scrollTop + element.clientHeight / 2) / Math.max(1, element.scrollHeight);
  zoom.value = next;
  await nextTick();
  element.scrollLeft = centerX * element.scrollWidth - element.clientWidth / 2;
  element.scrollTop = centerY * element.scrollHeight - element.clientHeight / 2;
}

const stepZoom = (direction) => setZoom(nextZoomStep(zoom.value, direction));

function onZoomKeydown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === '+' || event.key === '=') stepZoom(1);
  else if (event.key === '-' || event.key === '_') stepZoom(-1);
  else if (event.key === '0') setZoom(1);
  else return;
  event.preventDefault();
}

function onZoomWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  stepZoom(event.deltaY < 0 ? 1 : -1);
}

function onZoomCancel(event) {
  event.preventDefault();
  closeZoom();
}

// The dialog element itself is only hit on its backdrop.
function onZoomClick(event) {
  if (event.target === zoomDialog.value) closeZoom();
}

function startPan(event) {
  const element = zoomStage.value;
  if (event.button !== 0 || !element) return;
  if (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight) return;
  pan = { left: element.scrollLeft, top: element.scrollTop, x: event.clientX, y: event.clientY };
  element.setPointerCapture?.(event.pointerId);
}

function movePan(event) {
  if (!pan || !zoomStage.value) return;
  zoomStage.value.scrollLeft = pan.left - (event.clientX - pan.x);
  zoomStage.value.scrollTop = pan.top - (event.clientY - pan.y);
}

function endPan() {
  pan = null;
}

onMounted(() => {
  dark.value = document.documentElement.classList.contains('dark');
  observer = new MutationObserver(() => {
    const next = document.documentElement.classList.contains('dark');
    if (next !== dark.value) { dark.value = next; void draw(); }
  });
  observer.observe(document.documentElement, { attributeFilter: ['class'], attributes: true });
  void draw();
});
watch(() => [props.visual.source, props.visual.pending], () => { void draw(); });
onBeforeUnmount(() => {
  observer?.disconnect();
  stageObserver?.disconnect();
  chart?.destroy();
  zoomChart?.destroy();
  if (zoomDialog.value?.open) zoomDialog.value.close();
});
</script>

<template>
  <figure class="assistant-visual" :class="`assistant-visual--${visual.type}`">
    <p v-if="visual.pending" class="assistant-visual__pending" role="status">
      <AssistantTypingDots /> {{ PENDING_LABELS[visual.type] }}
    </p>
    <template v-else-if="error">
      <p class="assistant-visual__error">This {{ visual.type === 'chart' ? 'chart' : 'diagram' }} couldn't be drawn: {{ error }}</p>
      <pre class="assistant-visual__source"><code>{{ visual.source }}</code></pre>
    </template>
    <template v-else>
      <div v-if="visual.type === 'chart'" class="assistant-visual__chart" :style="{ height: `${chartHeight}px` }">
        <canvas ref="canvas" role="img" :aria-label="`${label}. Use Show data for the numbers.`"></canvas>
      </div>
      <div v-else ref="diagram" class="assistant-visual__diagram" role="img" :aria-label="label" @click="openZoom"></div>
      <div class="assistant-visual__bar">
        <button class="assistant-visual__toggle" type="button" @click="openZoom">
          <i class="bi bi-arrows-angle-expand" aria-hidden="true"></i> Enlarge
        </button>
        <button class="assistant-visual__toggle" type="button" :aria-expanded="showDetails" @click="showDetails = !showDetails">
          {{ showDetails ? 'Hide' : 'Show' }} {{ visual.type === 'chart' ? 'data' : 'source' }}
        </button>
      </div>
      <div v-if="showDetails && table" class="assistant-visual__table-wrap" tabindex="0" role="region" :aria-label="`${label} data`">
        <table class="assistant-visual__table">
          <caption class="visually-hidden">{{ label }}</caption>
          <thead><tr><th v-for="(header, index) in table.headers" :key="index" scope="col">{{ header }}</th></tr></thead>
          <tbody><tr v-for="(row, index) in table.rows" :key="index"><th scope="row">{{ row[0] }}</th><td v-for="(cell, cellIndex) in row.slice(1)" :key="cellIndex">{{ cell }}</td></tr></tbody>
        </table>
      </div>
      <pre v-else-if="showDetails" class="assistant-visual__source"><code>{{ visual.source }}</code></pre>
    </template>

    <dialog
      v-if="zoomOpen"
      ref="zoomDialog"
      class="assistant-zoom"
      :aria-labelledby="zoomTitleId"
      @cancel="onZoomCancel"
      @click="onZoomClick"
      @keydown="onZoomKeydown"
    >
      <div class="assistant-zoom__panel">
        <header class="assistant-zoom__head">
          <h2 :id="zoomTitleId" class="assistant-zoom__title">{{ label }}</h2>
          <div class="assistant-zoom__controls" role="group" aria-label="Zoom">
            <button class="assistant-zoom__button" type="button" aria-label="Zoom out" title="Zoom out (-)" :disabled="zoom <= ZOOM_STEPS[0]" @click="stepZoom(-1)">
              <i class="bi bi-zoom-out" aria-hidden="true"></i>
            </button>
            <button class="assistant-zoom__button assistant-zoom__level" type="button" aria-label="Fit to the window" title="Fit to the window (0)" @click="setZoom(1)">
              <span aria-hidden="true">{{ zoomLabel }}</span>
            </button>
            <button class="assistant-zoom__button" type="button" aria-label="Zoom in" title="Zoom in (+)" :disabled="zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]" @click="stepZoom(1)">
              <i class="bi bi-zoom-in" aria-hidden="true"></i>
            </button>
          </div>
          <span class="visually-hidden" aria-live="polite">Zoom {{ Math.round(zoom * 100) }}% of fit</span>
          <button class="assistant-zoom__button assistant-zoom__close" type="button" aria-label="Close" title="Close" @click="closeZoom">
            <i class="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </header>
        <div
          ref="zoomStage"
          class="assistant-zoom__stage"
          @pointercancel="endPan"
          @pointerdown="startPan"
          @pointermove="movePan"
          @pointerup="endPan"
          @wheel="onZoomWheel"
        >
          <div class="assistant-zoom__content" :class="`assistant-zoom__content--${visual.type}`" :style="zoomContentStyle">
            <canvas v-if="visual.type === 'chart'" ref="zoomCanvas" role="img" :aria-label="`${label}, enlarged.`"></canvas>
            <div v-else ref="zoomDiagram" class="assistant-zoom__diagram" role="img" :aria-label="`${label}, enlarged`"></div>
          </div>
        </div>
      </div>
    </dialog>
  </figure>
</template>

<style scoped>
.assistant-visual {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  margin: 0.25rem 0 0.75rem;
  padding: 0.75rem 0.9rem 0.4rem;
}

.assistant-visual__pending {
  align-items: center;
  color: var(--ink-soft);
  display: flex;
  font-size: 0.875rem;
  gap: 0.6rem;
  margin: 0;
  min-height: 3rem;
}

.assistant-visual__chart {
  position: relative;
  width: 100%;
}

.assistant-visual__diagram {
  cursor: zoom-in;
  display: flex;
  justify-content: center;
  overflow-x: auto;
}

.assistant-visual__diagram :deep(svg) {
  height: auto;
  max-width: 100%;
}

.assistant-visual__bar {
  display: flex;
  gap: 0.25rem;
  justify-content: flex-end;
}

.assistant-visual__toggle {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.5rem;
  color: var(--accent);
  display: inline-flex;
  font-size: 0.82rem;
  gap: 0.35rem;
  min-height: 2.75rem;
  padding: 0 0.6rem;
}

.assistant-visual__toggle:hover {
  background: var(--surface-tint);
}

.assistant-visual__table-wrap {
  overflow-x: auto;
  padding-bottom: 0.5rem;
}

.assistant-visual__table {
  border-collapse: collapse;
  font-size: 0.85rem;
  width: 100%;
}

.assistant-visual__table th,
.assistant-visual__table td {
  border-bottom: 1px solid var(--line);
  color: var(--ink);
  padding: 0.3rem 0.5rem;
  text-align: left;
}

.assistant-visual__table td {
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.assistant-visual__error {
  color: var(--muted);
  font-size: 0.85rem;
  margin: 0 0 0.4rem;
}

.assistant-visual__source {
  background: var(--surface-soft);
  border-radius: 0.5rem;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  margin: 0 0 0.5rem;
  max-height: 16rem;
  overflow: auto;
  padding: 0.6rem;
}

.assistant-zoom {
  background: var(--surface);
  border: 0;
  border-radius: 0.75rem;
  box-shadow: 0 24px 64px rgba(7, 17, 31, 0.4);
  color: var(--ink);
  height: min(94vh, 80rem);
  max-height: none;
  max-width: none;
  padding: 0;
  width: min(96vw, 120rem);
}

.assistant-zoom::backdrop {
  background: rgba(7, 17, 31, 0.72);
}

.assistant-zoom__panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.assistant-zoom__head {
  align-items: center;
  border-bottom: 1px solid var(--line);
  display: flex;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem 0.4rem 1rem;
}

.assistant-zoom__title {
  flex: 1 1 auto;
  font-size: 1rem !important;
  font-weight: 700;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assistant-zoom__controls {
  align-items: center;
  display: flex;
  flex: none;
}

.assistant-zoom__button {
  background: transparent;
  border: 0;
  border-radius: 0.45rem;
  color: var(--ink-soft);
  display: grid;
  flex: none;
  height: 2.75rem;
  min-width: 2.75rem;
  padding: 0 0.5rem;
  place-items: center;
}

.assistant-zoom__button:hover:not(:disabled) {
  background: var(--surface-tint);
  color: var(--ink);
}

.assistant-zoom__button:disabled {
  opacity: 0.45;
}

.assistant-zoom__level {
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
  min-width: 3.75rem;
}

.assistant-zoom__stage {
  cursor: grab;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 1.25rem;
}

.assistant-zoom__stage:active {
  cursor: grabbing;
}

/* margin: auto centres the picture while it fits and lets it scroll from the edge once it doesn't. */
.assistant-zoom__content {
  flex: none;
  margin: auto;
}

.assistant-zoom__content--chart {
  position: relative;
}

.assistant-zoom__diagram :deep(svg) {
  display: block;
  height: auto;
  max-width: none !important;
  width: 100%;
}
</style>
