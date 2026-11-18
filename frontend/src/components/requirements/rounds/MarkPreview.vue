<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import AnnotationOverlay from '../annotation/AnnotationOverlay.vue';

// A mark on the picture it was made on, small, as the visual anchor for its discussion in
// Marks and comments. The whole picture opens it larger (MarkLightbox). Without a picture
// (the snapshot failed, or it is still loading) the mark sits on a blank frame of the screen.
const props = defineProps({
  activeId: { default: null, type: String },
  height: { required: true, type: Number, validator: (value) => value > 0 },
  imageUrl: { default: '', type: String },
  // The button's name, such as "Enlarge mark 16 on Validate data".
  label: { required: true, type: String },
  loading: { default: false, type: Boolean },
  // toCanvasMark() results.
  marks: { default: () => [], type: Array },
  unavailableText: { default: 'No picture was saved for this mark', type: String },
  width: { required: true, type: Number, validator: (value) => value > 0 },
});

const emit = defineEmits(['open']);

const frame = ref(null);
const shownWidth = ref(0);
let observer = null;

const scale = computed(() => (shownWidth.value > 0 ? shownWidth.value / props.width : 1));

function measure() {
  shownWidth.value = frame.value?.clientWidth ?? 0;
}

onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && frame.value) {
    observer = new ResizeObserver(measure);
    observer.observe(frame.value);
  }
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="rq-markpreview">
    <div ref="frame" class="rq-markpreview__frame" :style="{ aspectRatio: `${width} / ${height}` }">
      <img v-if="imageUrl" class="rq-markpreview__image" :src="imageUrl" alt="" draggable="false" />
      <div v-else class="rq-markpreview__blank">
        <span>{{ loading ? 'Loading the picture…' : unavailableText }}</span>
      </div>
      <AnnotationOverlay :active-id="activeId" :height="height" :interactive="false" :marks="marks" :scale="scale" :width="width" />
    </div>
    <button class="rq-markpreview__open" type="button" :aria-label="label" @click="emit('open')">
      <span class="rq-markpreview__hint" aria-hidden="true"><i class="bi bi-arrows-fullscreen"></i>Enlarge</span>
    </button>
  </div>
</template>

<style scoped>
.rq-markpreview {
  position: relative;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  overflow: hidden;
  background: var(--surface-soft);
}

.rq-markpreview__frame {
  position: relative;
  width: 100%;
}

.rq-markpreview__image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: fill;
  user-select: none;
}

.rq-markpreview__blank {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  padding: 1rem;
  border: 2px dashed var(--line-strong);
  color: var(--muted);
  font-size: 0.8rem;
  text-align: center;
}

.rq-markpreview__open {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 0.5rem;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}

.rq-markpreview__hint {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  background: rgba(7, 17, 31, 0.78);
  color: #ffffff;
  font-size: 0.75rem;
  font-weight: 600;
  opacity: 0.85;
}

.rq-markpreview__open:hover .rq-markpreview__hint,
.rq-markpreview__open:focus-visible .rq-markpreview__hint {
  opacity: 1;
}

.rq-markpreview__open:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: -3px;
}
</style>
