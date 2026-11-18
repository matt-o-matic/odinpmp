<script setup>
import { computed, nextTick, ref, useId, watch } from 'vue';

import { DEFAULT_LAYER_COLOR, markNumbers, readableInk } from '../../../lib/requirements/annotation-shapes.js';
import { isMarkFaded, markDescription, markLabel, visibleMarks } from '../../../lib/requirements/annotation-layers.js';

const props = defineProps({
  activeId: { default: null, type: String },
  categoryLabels: { default: () => ({}), type: Object },
  emptyText: { default: 'No marks on this screen yet.', type: String },
  hiddenAuthors: { default: () => [], type: Array },
  label: { default: 'Marks on this screen', type: String },
  marks: { default: () => [], type: Array },
  showResolved: { default: true, type: Boolean },
});

const emit = defineEmits(['select', 'activate']);

const listEl = ref(null);
const focusedId = ref(null);
const baseId = useId();

// Numbers come from every mark, so hiding a layer never renumbers the others.
const items = computed(() => {
  const numbers = markNumbers(props.marks);
  return visibleMarks(props.marks, { hiddenAuthors: props.hiddenAuthors, showResolved: props.showResolved }).map((mark) => {
    const color = mark.color || DEFAULT_LAYER_COLOR;
    const number = numbers.get(mark.id);
    return {
      id: mark.id,
      number,
      color,
      ink: readableInk(color),
      faded: isMarkFaded(mark),
      label: markLabel(mark, { number, categoryLabels: props.categoryLabels }),
      text: markDescription(mark, { categoryLabels: props.categoryLabels }),
    };
  });
});

const tabId = computed(() => {
  const ids = items.value.map((item) => item.id);
  if (ids.includes(focusedId.value)) return focusedId.value;
  if (ids.includes(props.activeId)) return props.activeId;
  return ids[0] ?? null;
});

const optionId = (id) => `${baseId}-mark-${id}`;

watch(
  () => props.activeId,
  async (id) => {
    if (!id) return;
    focusedId.value = id;
    await nextTick();
    // Keep the selected mark visible when it was chosen on the canvas, without taking focus.
    listEl.value?.querySelector(`[data-mark-id="${CSS.escape(id)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  },
);

function focusItem(id) {
  focusedId.value = id;
  nextTick(() => listEl.value?.querySelector(`[data-mark-id="${CSS.escape(id)}"]`)?.focus());
}

function choose(id) {
  focusedId.value = id;
  if (id !== props.activeId) emit('select', id);
}

function onKeydown(event) {
  const ids = items.value.map((item) => item.id);
  if (!ids.length) return;
  const index = Math.max(0, ids.indexOf(tabId.value));
  let next = null;
  if (event.key === 'ArrowDown') next = ids[Math.min(ids.length - 1, index + 1)];
  else if (event.key === 'ArrowUp') next = ids[Math.max(0, index - 1)];
  else if (event.key === 'Home') next = ids[0];
  else if (event.key === 'End') next = ids.at(-1);
  else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    choose(ids[index]);
    emit('activate', ids[index]);
    return;
  } else return;
  event.preventDefault();
  // Selection follows focus, so the canvas highlights each mark as the reader moves through the list.
  focusItem(next);
  choose(next);
}
</script>

<template>
  <div class="annotation-list">
    <p v-if="!items.length" class="annotation-list__empty">{{ emptyText }}</p>
    <ul
      v-else
      ref="listEl"
      class="annotation-list__items"
      role="listbox"
      :aria-label="label"
      @keydown="onKeydown"
    >
      <li
        v-for="item in items"
        :id="optionId(item.id)"
        :key="item.id"
        class="annotation-list__item"
        :class="{ 'annotation-list__item--active': item.id === activeId, 'annotation-list__item--faded': item.faded }"
        role="option"
        :data-mark-id="item.id"
        :aria-selected="item.id === activeId ? 'true' : 'false'"
        :aria-label="item.label"
        :tabindex="item.id === tabId ? 0 : -1"
        @click="choose(item.id)"
        @dblclick="emit('activate', item.id)"
        @focus="focusedId = item.id"
      >
        <span class="annotation-list__number" :style="{ '--mark-color': item.color, '--mark-ink': item.ink }" aria-hidden="true">{{ item.number }}</span>
        <span class="annotation-list__text" aria-hidden="true">{{ item.text }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.annotation-list__empty {
  margin: 0;
  color: var(--muted);
  font-size: 0.86rem;
}

.annotation-list__items {
  display: grid;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.annotation-list__item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 40px;
  padding: 0.35rem 0.6rem;
  border: 1px solid transparent;
  border-radius: 0.45rem;
  color: var(--ink);
  font-size: 0.86rem;
  cursor: pointer;
}

.annotation-list__item:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 1px;
}

.annotation-list__item--active {
  border-color: var(--accent);
  background: var(--surface-tint);
}

.annotation-list__item--faded .annotation-list__number,
.annotation-list__item--faded .annotation-list__text {
  opacity: 0.6;
}

@media (hover: hover) {
  .annotation-list__item:hover {
    background: var(--surface-soft);
  }
}

.annotation-list__number {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  min-width: 1.6rem;
  height: 1.6rem;
  padding: 0 0.3rem;
  border-radius: 999px;
  background: var(--mark-color);
  color: var(--mark-ink);
  font-size: 0.72rem;
  font-weight: 700;
}

.annotation-list__text {
  min-width: 0;
  overflow-wrap: anywhere;
}

@media (pointer: coarse) {
  .annotation-list__item {
    min-height: 44px;
  }
}
</style>
