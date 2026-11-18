<script setup>
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

import { focusOrigin } from '../../../lib/ui/focus-origin.js';
import AnnotationCanvas from '../annotation/AnnotationCanvas.vue';

// A mark's picture, large, in a modal over Marks and comments: the read-only annotation
// canvas, so it zooms and pans like the review does. Escape, the close button, or a click
// outside the picture closes it, and focus returns to what opened it.
const props = defineProps({
  activeId: { default: null, type: String },
  categoryLabels: { default: () => ({}), type: Object },
  height: { required: true, type: Number },
  imageAlt: { default: '', type: String },
  imageUrl: { default: '', type: String },
  // toCanvasMark() results.
  marks: { default: () => [], type: Array },
  open: { default: false, type: Boolean },
  title: { required: true, type: String },
  unavailableText: { default: 'No picture was saved for this mark', type: String },
  width: { required: true, type: Number },
});

const emit = defineEmits(['close']);

const titleId = useId();
const dialog = ref(null);
let opener = null;

watch(
  () => props.open,
  async (open) => {
    await nextTick();
    const element = dialog.value;
    if (!element) return;
    if (open && !element.open) {
      opener = typeof document !== 'undefined' ? focusOrigin() : null;
      element.showModal?.();
      element.querySelector('.rq-lightbox__close')?.focus();
    } else if (!open && element.open) {
      element.close();
      const target = opener;
      opener = null;
      if (target && document.contains(target)) target.focus?.();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (dialog.value?.open) dialog.value.close();
});

function onCancel(event) {
  event.preventDefault();
  emit('close');
}

// The dialog element itself is only hit on its backdrop.
function onClick(event) {
  if (event.target === dialog.value) emit('close');
}
</script>

<template>
  <dialog ref="dialog" class="rq-lightbox" :aria-labelledby="titleId" @cancel="onCancel" @click="onClick">
    <div class="rq-lightbox__panel">
      <header class="rq-lightbox__head">
        <h2 :id="titleId" class="rq-lightbox__title">{{ title }}</h2>
        <button class="rq-lightbox__close" type="button" aria-label="Close" @click="emit('close')">
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </header>
      <div class="rq-lightbox__body">
        <AnnotationCanvas
          v-if="open"
          :active-id="activeId"
          :category-labels="categoryLabels"
          :height="height"
          :image-alt="imageAlt"
          :image-url="imageUrl"
          :label="title"
          :marks="marks"
          readonly
          :screen-key="activeId || ''"
          :show-resolved="true"
          :unavailable-text="unavailableText"
          :width="width"
        />
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.rq-lightbox {
  width: min(96vw, 110rem);
  max-width: none;
  height: min(94vh, 70rem);
  max-height: none;
  padding: 0;
  border: 0;
  border-radius: 0.75rem;
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 24px 64px rgba(7, 17, 31, 0.4);
}

.rq-lightbox::backdrop {
  background: rgba(7, 17, 31, 0.72);
}

.rq-lightbox__panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.rq-lightbox__head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.75rem 0.6rem 1rem;
  border-bottom: 1px solid var(--line);
}

.rq-lightbox__title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 1rem;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rq-lightbox__close {
  display: grid;
  flex: none;
  place-items: center;
  width: 2.75rem;
  height: 2.75rem;
  padding: 0;
  border: 0;
  border-radius: 0.45rem;
  background: transparent;
  color: var(--ink-soft);
}

.rq-lightbox__close:hover {
  background: var(--surface-soft);
}

.rq-lightbox__body {
  flex: 1 1 auto;
  min-height: 0;
}
</style>
