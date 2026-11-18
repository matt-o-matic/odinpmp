<script setup>
import { computed, ref } from 'vue';

import { ANNOTATION_TOOLS, STROKE_WIDTHS, annotationPalette } from '../../../lib/requirements/annotation-shapes.js';
import { TOOL_META, swatchLabel } from '../../../lib/requirements/annotation-tools.js';

const props = defineProps({
  canDelete: { default: false, type: Boolean },
  canRedo: { default: false, type: Boolean },
  canUndo: { default: false, type: Boolean },
  disabled: { default: false, type: Boolean },
  label: { default: 'Annotation tools', type: String },
  palette: { default: () => annotationPalette(), type: Array },
  showDelete: { default: true, type: Boolean },
  showHistory: { default: true, type: Boolean },
  showStyle: { default: true, type: Boolean },
  tools: { default: () => [...ANNOTATION_TOOLS], type: Array },
});

const tool = defineModel('tool', { default: 'select', type: String });
const color = defineModel('color', { default: '', type: String });
const stroke = defineModel('stroke', { default: STROKE_WIDTHS.thin, type: Number });
const emit = defineEmits(['undo', 'redo', 'delete']);

const toolbarEl = ref(null);
const rovingKey = ref('');

const visibleTools = computed(() => props.tools.filter((id) => TOOL_META[id]));
const strokes = [
  { value: STROKE_WIDTHS.thin, label: 'Thin stroke', tip: 'Thin stroke' },
  { value: STROKE_WIDTHS.thick, label: 'Thick stroke', tip: 'Thick stroke' },
];
const activeColor = computed(() => (props.palette.includes(color.value) ? color.value : props.palette[0]));

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const mod = isMac ? 'Cmd' : 'Ctrl';

// One button in the toolbar is in the tab order at a time; arrow keys move between them.
const enabledKeys = computed(() => {
  if (props.disabled) return [];
  const keys = visibleTools.value.map((id) => `tool:${id}`);
  if (props.showStyle) keys.push(...props.palette.map((c) => `color:${c}`), ...strokes.map((s) => `stroke:${s.value}`));
  if (props.showHistory) {
    if (props.canUndo) keys.push('undo');
    if (props.canRedo) keys.push('redo');
  }
  if (props.showDelete && props.canDelete) keys.push('delete');
  return keys;
});
const tabKey = computed(() => {
  if (enabledKeys.value.includes(rovingKey.value)) return rovingKey.value;
  const current = `tool:${tool.value}`;
  return enabledKeys.value.includes(current) ? current : enabledKeys.value[0];
});

function onKeydown(event) {
  const moves = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (!(event.key in moves) && event.key !== 'Home' && event.key !== 'End') return;
  const buttons = [...toolbarEl.value.querySelectorAll('button[data-key]:not([disabled])')];
  if (!buttons.length) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement);
  let next;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  else next = (Math.max(0, index) + moves[event.key] + buttons.length) % buttons.length;
  buttons[next].focus();
}

function chooseTool(id) {
  tool.value = id;
}
</script>

<template>
  <div
    ref="toolbarEl"
    class="annotation-toolbar"
    role="toolbar"
    :aria-label="label"
    aria-orientation="horizontal"
    @keydown="onKeydown"
    @focusin="rovingKey = $event.target?.dataset?.key || rovingKey"
  >
    <button
      v-for="id in visibleTools"
      :key="id"
      type="button"
      class="annotation-toolbar__button"
      :class="{ 'annotation-toolbar__button--on': tool === id }"
      :data-key="`tool:${id}`"
      :tabindex="tabKey === `tool:${id}` ? 0 : -1"
      :aria-label="TOOL_META[id].label"
      :aria-pressed="tool === id ? 'true' : 'false'"
      :aria-keyshortcuts="TOOL_META[id].key"
      :disabled="disabled"
      @click="chooseTool(id)"
    >
      <i :class="['bi', TOOL_META[id].icon]" aria-hidden="true"></i>
      <span class="annotation-toolbar__tip" aria-hidden="true">{{ TOOL_META[id].label }} ({{ TOOL_META[id].key }})</span>
    </button>

    <template v-if="showStyle">
      <span class="annotation-toolbar__sep" aria-hidden="true"></span>
      <button
        v-for="(swatch, index) in palette"
        :key="swatch"
        type="button"
        class="annotation-toolbar__button annotation-toolbar__swatch"
        :class="{ 'annotation-toolbar__swatch--on': activeColor === swatch }"
        :style="{ '--swatch-color': swatch }"
        :data-key="`color:${swatch}`"
        :tabindex="tabKey === `color:${swatch}` ? 0 : -1"
        :aria-label="swatchLabel(swatch, index)"
        :aria-pressed="activeColor === swatch ? 'true' : 'false'"
        :disabled="disabled"
        @click="color = swatch"
      >
        <span class="annotation-toolbar__dot" aria-hidden="true"></span>
        <span class="annotation-toolbar__tip" aria-hidden="true">{{ swatchLabel(swatch, index) }}</span>
      </button>
      <span class="annotation-toolbar__sep" aria-hidden="true"></span>
      <button
        v-for="option in strokes"
        :key="option.value"
        type="button"
        class="annotation-toolbar__button annotation-toolbar__stroke"
        :class="{ 'annotation-toolbar__button--on': stroke === option.value }"
        :data-key="`stroke:${option.value}`"
        :tabindex="tabKey === `stroke:${option.value}` ? 0 : -1"
        :aria-label="option.label"
        :aria-pressed="stroke === option.value ? 'true' : 'false'"
        :disabled="disabled"
        @click="stroke = option.value"
      >
        <span class="annotation-toolbar__line" :style="{ '--line-width': `${option.value / 1.5}px` }" aria-hidden="true"></span>
        <span class="annotation-toolbar__tip" aria-hidden="true">{{ option.tip }}</span>
      </button>
    </template>

    <template v-if="showHistory || showDelete">
      <span class="annotation-toolbar__sep" aria-hidden="true"></span>
      <template v-if="showHistory">
        <button
          type="button"
          class="annotation-toolbar__button"
          data-key="undo"
          :tabindex="tabKey === 'undo' ? 0 : -1"
          aria-label="Undo"
          :aria-keyshortcuts="isMac ? 'Meta+Z' : 'Control+Z'"
          :disabled="disabled || !canUndo"
          @click="emit('undo')"
        >
          <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>
          <span class="annotation-toolbar__tip" aria-hidden="true">Undo ({{ mod }}+Z)</span>
        </button>
        <button
          type="button"
          class="annotation-toolbar__button"
          data-key="redo"
          :tabindex="tabKey === 'redo' ? 0 : -1"
          aria-label="Redo"
          :aria-keyshortcuts="isMac ? 'Meta+Shift+Z' : 'Control+Shift+Z'"
          :disabled="disabled || !canRedo"
          @click="emit('redo')"
        >
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
          <span class="annotation-toolbar__tip" aria-hidden="true">Redo ({{ mod }}+Shift+Z)</span>
        </button>
      </template>
      <button
        v-if="showDelete"
        type="button"
        class="annotation-toolbar__button"
        data-key="delete"
        :tabindex="tabKey === 'delete' ? 0 : -1"
        aria-label="Delete selected mark"
        aria-keyshortcuts="Delete"
        :disabled="disabled || !canDelete"
        @click="emit('delete')"
      >
        <i class="bi bi-trash3" aria-hidden="true"></i>
        <span class="annotation-toolbar__tip" aria-hidden="true">Delete (Del)</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.annotation-toolbar {
  --annotation-target: 40px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
  max-width: 100%;
  padding: 0.3rem;
  border: 1px solid var(--line);
  border-radius: 0.7rem;
  background: color-mix(in srgb, var(--surface) 97%, transparent);
  box-shadow: var(--shadow-strong);
}

.annotation-toolbar__button {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: var(--annotation-target);
  height: var(--annotation-target);
  padding: 0;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--ink-soft);
  font-size: 1.1rem;
  cursor: pointer;
}

.annotation-toolbar__button:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 1px;
}

.annotation-toolbar__button:disabled {
  cursor: default;
  opacity: 0.4;
}

.annotation-toolbar__button--on {
  background: var(--accent);
  color: var(--surface);
}

.annotation-toolbar__sep {
  flex: none;
  width: 1px;
  height: 1.8rem;
  margin: 0 0.25rem;
  background: var(--line);
}

.annotation-toolbar__dot {
  width: 20px;
  height: 20px;
  border: 2px solid var(--surface);
  border-radius: 999px;
  background: var(--swatch-color);
  box-shadow: 0 0 0 1px var(--line-strong);
}

.annotation-toolbar__swatch--on .annotation-toolbar__dot {
  box-shadow: 0 0 0 2px var(--ink);
}

.annotation-toolbar__line {
  width: 1.2rem;
  height: var(--line-width);
  border-radius: 999px;
  background: currentColor;
}

.annotation-toolbar__tip {
  position: absolute;
  bottom: calc(100% + 0.45rem);
  left: 50%;
  z-index: 2;
  display: none;
  padding: 0.25rem 0.5rem;
  border-radius: 0.35rem;
  background: var(--ink);
  color: var(--surface);
  font-family: var(--font-sans);
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  transform: translateX(-50%);
}

.annotation-toolbar__button:focus-visible .annotation-toolbar__tip {
  display: block;
}

@media (hover: hover) {
  .annotation-toolbar__button:not(:disabled):hover {
    background: var(--surface-tint);
    color: var(--ink);
  }

  .annotation-toolbar__button--on:not(:disabled):hover {
    background: var(--accent-dark);
    color: #ffffff;
  }

  .annotation-toolbar__button:hover .annotation-toolbar__tip {
    display: block;
  }
}

@media (pointer: coarse) {
  .annotation-toolbar {
    --annotation-target: 44px;
  }
}
</style>
