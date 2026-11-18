<script setup>
import { computed } from 'vue';

import { isMarkFaded, isMarkVisible, markLabel } from '../../../lib/requirements/annotation-layers.js';
import { DEFAULT_LAYER_COLOR, arrowPath, markNumbers, normalizeColor, readableInk, textLabelColors, textMetrics } from '../../../lib/requirements/annotation-shapes.js';

// Marks drawn read-only over a live surface, such as a prototype while the reviewer browses
// it. Only the pins take clicks, so the surface underneath stays usable; with
// `interactive: false` nothing does, for a picture that is itself a button. The parent sizes
// the overlay to the surface as shown; shapes are in surface pixels, and a mark's optional
// `offset` shifts it, for example by how far the page scrolled since its snapshot.
const props = defineProps({
  activeId: { default: null, type: String },
  categoryLabels: { default: () => ({}), type: Object },
  height: { required: true, type: Number, validator: (value) => value > 0 },
  hiddenAuthors: { default: () => [], type: Array },
  interactive: { default: true, type: Boolean },
  label: { default: 'Marks', type: String },
  // toCanvasMark() results, each with an optional { x, y } offset.
  marks: { default: () => [], type: Array },
  // CSS px per surface pixel.
  scale: { default: 1, type: Number },
  showResolved: { default: true, type: Boolean },
  width: { required: true, type: Number, validator: (value) => value > 0 },
});

const emit = defineEmits(['pin-click']);

const pct = (value, total) => `${(value / total) * 100}%`;

const numbers = computed(() => markNumbers(props.marks));
const shownMarks = computed(() => props.marks
  .filter((mark) => mark.id === props.activeId || isMarkVisible(mark, { hiddenAuthors: props.hiddenAuthors, showResolved: props.showResolved }))
  .map((mark) => ({ ...mark, offset: { x: Number(mark.offset?.x) || 0, y: Number(mark.offset?.y) || 0 } })));
const pins = computed(() => shownMarks.value.flatMap((mark) => (mark.shapes || []).flatMap((shape, index) => {
  if (shape?.type !== 'pin') return [];
  const number = numbers.value.get(mark.id);
  const color = normalizeColor(mark.color) || shape.style?.color || DEFAULT_LAYER_COLOR;
  return [{
    active: mark.id === props.activeId,
    color,
    faded: isMarkFaded(mark),
    id: mark.id,
    ink: readableInk(color),
    key: `${mark.id}:${index}`,
    label: markLabel(mark, { categoryLabels: props.categoryLabels, number }),
    left: pct(shape.x + mark.offset.x, props.width),
    number,
    top: pct(shape.y + mark.offset.y, props.height),
  }];
})));
const textLayerStyle = computed(() => ({ height: `${props.height}px`, transform: `scale(${props.scale})`, width: `${props.width}px` }));

function textStyle(shape, offset) {
  const metrics = textMetrics(shape.fontSize);
  return {
    color: textLabelColors(shape.style?.color).ink,
    fontSize: `${shape.fontSize}px`,
    height: `${shape.h}px`,
    left: `${shape.x + offset.x}px`,
    lineHeight: `${metrics.lineHeight}px`,
    padding: `${metrics.padding}px`,
    top: `${shape.y + offset.y}px`,
    width: `${shape.w}px`,
  };
}

function penPoints(shape) {
  return shape.points.map(([x, y]) => `${x},${y}`).join(' ');
}

function boxRadius(shape) {
  return Math.min(8, shape.w / 4, shape.h / 4);
}
</script>

<template>
  <div class="annotation-overlay" :role="interactive ? 'group' : undefined" :aria-label="interactive ? label : undefined" :aria-hidden="interactive ? undefined : 'true'">
    <svg class="annotation-overlay__marks" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <g
        v-for="mark in shownMarks"
        :key="mark.id"
        :class="{ 'annotation-overlay__mark--faded': isMarkFaded(mark) }"
        :transform="`translate(${mark.offset.x} ${mark.offset.y})`"
      >
        <template v-for="(shape, index) in mark.shapes" :key="index">
          <rect
            v-if="shape.type === 'box'"
            :x="shape.x"
            :y="shape.y"
            :width="shape.w"
            :height="shape.h"
            :rx="boxRadius(shape)"
            fill="none"
            :stroke="shape.style.color"
            :stroke-width="shape.style.stroke"
          />
          <rect
            v-else-if="shape.type === 'highlight'"
            class="annotation-overlay__highlight"
            :x="shape.x"
            :y="shape.y"
            :width="shape.w"
            :height="shape.h"
            rx="2"
            :fill="shape.style.color"
          />
          <path
            v-else-if="shape.type === 'arrow'"
            :d="arrowPath(shape)"
            fill="none"
            :stroke="shape.style.color"
            :stroke-width="shape.style.stroke"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <polyline
            v-else-if="shape.type === 'pen'"
            :points="penPoints(shape)"
            fill="none"
            :stroke="shape.style.color"
            :stroke-width="shape.style.stroke"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <rect
            v-else-if="shape.type === 'text'"
            :x="shape.x"
            :y="shape.y"
            :width="shape.w"
            :height="shape.h"
            rx="4"
            :fill="textLabelColors(shape.style.color).fill"
            fill-opacity="0.94"
            :stroke="textLabelColors(shape.style.color).frame"
            stroke-width="1.5"
            vector-effect="non-scaling-stroke"
          />
        </template>
      </g>
    </svg>

    <div class="annotation-overlay__texts" :style="textLayerStyle" aria-hidden="true">
      <template v-for="mark in shownMarks" :key="mark.id">
        <template v-for="(shape, index) in mark.shapes" :key="index">
          <div
            v-if="shape.type === 'text'"
            class="annotation-overlay__text"
            :class="{ 'annotation-overlay__mark--faded': isMarkFaded(mark) }"
            :style="textStyle(shape, mark.offset)"
          >{{ shape.text }}</div>
        </template>
      </template>
    </div>

    <template v-for="pin in pins" :key="pin.key">
      <button
        v-if="interactive"
        type="button"
        class="annotation-overlay__pin"
        :class="{ 'annotation-overlay__pin--active': pin.active, 'annotation-overlay__pin--faded': pin.faded }"
        :style="{ left: pin.left, top: pin.top, '--pin-color': pin.color, '--pin-ink': pin.ink }"
        :data-pin-id="pin.id"
        :aria-label="pin.label"
        :aria-current="pin.active ? 'true' : undefined"
        @click="emit('pin-click', pin.id)"
      >
        <span aria-hidden="true">{{ pin.number }}</span>
      </button>
      <span
        v-else
        class="annotation-overlay__pin annotation-overlay__pin--static"
        :class="{ 'annotation-overlay__pin--faded': pin.faded }"
        :style="{ left: pin.left, top: pin.top, '--pin-color': pin.color, '--pin-ink': pin.ink }"
        :data-pin-id="pin.id"
      ><span>{{ pin.number }}</span></span>
    </template>
  </div>
</template>

<style scoped>
.annotation-overlay {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.annotation-overlay__marks {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.annotation-overlay__highlight {
  fill-opacity: 0.35;
  mix-blend-mode: multiply;
}

.annotation-overlay__mark--faded {
  opacity: 0.4;
}

.annotation-overlay__texts {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

.annotation-overlay__text {
  position: absolute;
  box-sizing: border-box;
  overflow: hidden;
  border-radius: 4px;
  font-family: var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* The same marker as the annotation canvas: its tip sits on the point. */
.annotation-overlay__pin {
  --pin-size: 28px;
  position: absolute;
  z-index: 2;
  display: grid;
  place-items: center;
  width: var(--pin-size);
  height: var(--pin-size);
  min-height: 0;
  margin: calc(var(--pin-size) * -1.2071) 0 0 calc(var(--pin-size) * -0.5);
  padding: 0;
  border: 2px solid #ffffff;
  border-radius: 999px 999px 999px 0;
  background: var(--pin-color);
  box-shadow: 0 6px 14px rgba(7, 17, 31, 0.25);
  rotate: -45deg;
  cursor: pointer;
  pointer-events: auto;
}

.annotation-overlay__pin::before {
  position: absolute;
  inset: -8px;
  content: '';
}

.annotation-overlay__pin span {
  color: var(--pin-ink);
  font-size: 11px;
  font-weight: 700;
  rotate: 45deg;
}

.annotation-overlay__pin--static {
  cursor: inherit;
  pointer-events: none;
}

.annotation-overlay__pin--active {
  z-index: 3;
  outline: 3px solid color-mix(in srgb, var(--pin-color) 35%, transparent);
  outline-offset: 2px;
}

.annotation-overlay__pin--faded {
  opacity: 0.4;
}

.annotation-overlay__pin:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}
</style>
