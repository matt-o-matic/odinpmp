<script setup>
import { initials } from '../../../lib/requirements/annotation-layers.js';

defineProps({
  label: { default: 'Layers', type: String },
  // From buildLayers(): [{ ref, name, color, count, self }]
  layers: { default: () => [], type: Array },
});

const hiddenAuthors = defineModel('hiddenAuthors', { default: () => [], type: Array });
const showResolved = defineModel('showResolved', { default: false, type: Boolean });

function toggle(ref) {
  const hidden = hiddenAuthors.value || [];
  hiddenAuthors.value = hidden.includes(ref) ? hidden.filter((value) => value !== ref) : [...hidden, ref];
}

function layerName(layer) {
  const count = layer.count ?? 0;
  return `${layer.name}${layer.self ? ' (you)' : ''}, ${count} ${count === 1 ? 'mark' : 'marks'}`;
}
</script>

<template>
  <div class="annotation-layers" role="group" :aria-label="label">
    <i class="bi bi-layers" aria-hidden="true"></i>
    <strong class="annotation-layers__title" aria-hidden="true">{{ label }}</strong>
    <button
      v-for="layer in layers"
      :key="layer.ref"
      type="button"
      class="annotation-layers__toggle"
      :class="{ 'annotation-layers__toggle--hidden': hiddenAuthors.includes(layer.ref) }"
      :style="{ '--layer-color': layer.color }"
      :aria-label="layerName(layer)"
      :aria-pressed="hiddenAuthors.includes(layer.ref) ? 'false' : 'true'"
      @click="toggle(layer.ref)"
    >
      <span class="annotation-layers__avatar" aria-hidden="true">{{ initials(layer.name) }}</span>
      <span class="annotation-layers__tip" aria-hidden="true">
        {{ hiddenAuthors.includes(layer.ref) ? 'Show' : 'Hide' }} {{ layer.self ? 'your' : `${layer.name}'s` }} marks
      </span>
    </button>
    <label class="annotation-layers__resolved">
      <input v-model="showResolved" type="checkbox" class="form-check-input" />
      <span>Show resolved</span>
    </label>
  </div>
</template>

<style scoped>
.annotation-layers {
  --annotation-target: 40px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.15rem 0.3rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--line);
  border-radius: 0.6rem;
  background: color-mix(in srgb, var(--surface) 96%, transparent);
  box-shadow: var(--shadow);
  color: var(--ink);
  font-size: 0.78rem;
}

.annotation-layers__title {
  margin-right: 0.15rem;
}

.annotation-layers__toggle {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: var(--annotation-target);
  height: var(--annotation-target);
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
}

.annotation-layers__toggle:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: -2px;
}

.annotation-layers__avatar {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1.5px solid color-mix(in srgb, var(--layer-color) 55%, var(--surface));
  border-radius: 999px;
  background: color-mix(in srgb, var(--layer-color) 14%, var(--surface));
  color: color-mix(in srgb, var(--layer-color) 80%, var(--ink));
  font-size: 0.64rem;
  font-weight: 700;
}

.annotation-layers__toggle--hidden .annotation-layers__avatar {
  border-style: dashed;
  opacity: 0.4;
}

.annotation-layers__tip {
  position: absolute;
  top: calc(100% + 0.3rem);
  left: 50%;
  z-index: 2;
  display: none;
  padding: 0.25rem 0.5rem;
  border-radius: 0.35rem;
  background: var(--ink);
  color: var(--surface);
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  transform: translateX(-50%);
}

.annotation-layers__toggle:focus-visible .annotation-layers__tip {
  display: block;
}

@media (hover: hover) {
  .annotation-layers__toggle:hover .annotation-layers__tip {
    display: block;
  }
}

.annotation-layers__resolved {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: var(--annotation-target);
  padding: 0 0.25rem;
  color: var(--muted);
  cursor: pointer;
}

/* Odin's coarse-pointer rule gives every input a 44 px minimum height; the label carries the target size. */
.annotation-layers__resolved input {
  flex: none;
  min-height: 0;
  margin: 0;
}

@media (pointer: coarse) {
  .annotation-layers {
    --annotation-target: 44px;
  }
}
</style>
