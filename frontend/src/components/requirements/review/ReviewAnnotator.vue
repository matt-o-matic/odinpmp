<script setup>
import { computed, nextTick, ref, watch } from 'vue';

import AnnotationCanvas from '../annotation/AnnotationCanvas.vue';
import AnnotationLayerBar from '../annotation/AnnotationLayerBar.vue';
import AnnotationToolbar from '../annotation/AnnotationToolbar.vue';
import ReviewAnnotationThread from './ReviewAnnotationThread.vue';
import { annotationLayers, editorHiddenAuthors, reviewActor, toCanvasMark } from '../../../lib/requirements/review-annotations.js';
import { useReviewSession } from '../../../lib/requirements/review-session.js';
import { PHONE_TOOLS } from '../../../lib/requirements/review-viewport.js';

// One annotation surface: an image screen, a prototype snapshot, or a blank frame when the
// snapshot could not be taken. Wires the editor to the review session: every mark the
// reviewer makes, moves or deletes is saved in the background, and other reviewers' marks
// arrive through live updates. Threads open in the mark's popover, or below on a phone.
const props = defineProps({
  annotations: { default: () => [], type: Array },
  bounds: { required: true, type: Object },
  // Optional `(shapes) => Promise<hint | null>` for prototype snapshots.
  hintFor: { default: null, type: Function },
  imageAlt: { default: '', type: String },
  imageUrl: { default: '', type: String },
  label: { default: 'Annotation canvas', type: String },
  phone: { default: false, type: Boolean },
  screenId: { required: true, type: String },
  snapshot: { default: null, type: Object },
  surfaceKey: { required: true, type: String },
  unavailableText: { default: 'Screen unavailable', type: String },
});

const activeId = defineModel('activeId', { default: null, type: String });
const hiddenAuthors = defineModel('hiddenAuthors', { default: () => [], type: Array });
const showResolved = defineModel('showResolved', { default: false, type: Boolean });

const session = useReviewSession();
const canvas = ref(null);
const thread = ref(null);
const tool = ref('select');
const color = ref('');
const stroke = ref(3);
const freshIds = ref([]);

const readOnly = computed(() => !session.canAnnotate());
const me = computed(() => reviewActor(session.state.data?.me));
const marks = computed(() => props.annotations.map((annotation) => toCanvasMark(annotation, { bounds: props.bounds, readOnly: readOnly.value })));
const layers = computed(() => annotationLayers(props.annotations, { actor: me.value, readOnly: readOnly.value }));
const editorHidden = computed(() => editorHiddenAuthors(hiddenAuthors.value));
const categoryLabels = computed(() => Object.fromEntries((session.state.content?.dimensions ?? []).map((dimension) => [dimension.key, dimension.label])));
const selected = computed(() => props.annotations.find((annotation) => annotation.id === activeId.value) ?? null);
const selectedNumber = computed(() => marks.value.find((mark) => mark.id === activeId.value)?.number ?? null);

watch(() => props.surfaceKey, () => {
  tool.value = 'select';
});

// A mark is "fresh" (its composer opens and Cancel removes it) only until the reviewer moves on.
watch(activeId, (next, previous) => {
  if (previous && previous !== next) freshIds.value = freshIds.value.filter((id) => id !== previous);
});

function onCreate({ id, number, restored, shapes }) {
  const hint = !restored && props.hintFor ? props.hintFor(shapes) : null;
  session.createAnnotation({ bounds: props.bounds, screenId: props.screenId, snapshot: props.snapshot }, { hint, id, number, restored, shapes });
  if (!restored) freshIds.value = [...freshIds.value, id];
  activeId.value = id;
}

function onUpdate(id, shapes) {
  session.updateAnnotationShapes(id, shapes);
}

function onDelete(id) {
  session.deleteAnnotation(id);
  freshIds.value = freshIds.value.filter((entry) => entry !== id);
  if (activeId.value === id) activeId.value = null;
}

function onSelect(id) {
  activeId.value = id;
}

async function onPinClick(id) {
  activeId.value = id;
  await nextTick();
  thread.value?.focus?.();
}

function closeThread() {
  activeId.value = null;
  canvas.value?.focus?.();
}

// Cancel on a brand-new mark with no comment removes it, through the editor so Undo works.
function discard() {
  canvas.value?.deleteSelected?.();
  canvas.value?.focus?.();
}

function isFresh(annotation) {
  return Boolean(annotation) && freshIds.value.includes(annotation.id);
}

defineExpose({
  focus: () => canvas.value?.focus?.(),
  openThread: async (id) => {
    activeId.value = id;
    await nextTick();
    thread.value?.focus?.();
  },
});
</script>

<template>
  <div class="rq-annotator" :class="{ 'rq-annotator--phone': phone }">
    <div class="rq-annotator__canvas">
      <AnnotationCanvas
        ref="canvas"
        v-model:color="color"
        v-model:stroke="stroke"
        v-model:tool="tool"
        :active-id="activeId"
        :category-labels="categoryLabels"
        :current-actor="readOnly ? null : me"
        :height="bounds.height"
        :hidden-authors="editorHidden"
        :image-alt="imageAlt"
        :image-url="imageUrl"
        :label="label"
        :marks="marks"
        :readonly="readOnly"
        :screen-key="surfaceKey"
        :show-resolved="showResolved"
        :show-zoom="!phone"
        :unavailable-text="unavailableText"
        :width="bounds.width"
        @create="onCreate"
        @delete="onDelete"
        @pin-click="onPinClick"
        @select="onSelect"
        @update="onUpdate"
      >
        <template v-if="!phone" #controls>
          <AnnotationLayerBar v-model:hidden-authors="hiddenAuthors" v-model:show-resolved="showResolved" :layers="layers" />
        </template>
        <template v-if="!readOnly" #toolbar="bar">
          <AnnotationToolbar
            :can-delete="bar.canDelete"
            :can-redo="bar.canRedo"
            :can-undo="bar.canUndo"
            :color="bar.color"
            :disabled="bar.readonly"
            :palette="bar.palette"
            :show-delete="!phone"
            :show-style="!phone"
            :stroke="bar.stroke"
            :tool="bar.tool"
            :tools="phone ? [...PHONE_TOOLS] : undefined"
            @delete="bar.deleteSelected()"
            @redo="bar.redo()"
            @undo="bar.undo()"
            @update:color="bar.setColor"
            @update:stroke="bar.setStroke"
            @update:tool="bar.setTool"
          />
        </template>
        <template v-if="!phone" #popover="{ mark, number }">
          <ReviewAnnotationThread
            v-if="annotations.find((entry) => entry.id === mark.id)"
            ref="thread"
            :annotation="annotations.find((entry) => entry.id === mark.id)"
            :fresh="isFresh(annotations.find((entry) => entry.id === mark.id))"
            :number="number"
            @close="closeThread"
            @discard="discard"
          />
        </template>
      </AnnotationCanvas>
    </div>

    <template v-if="phone">
      <p class="rq-xs rq-muted mb-0 rq-annotator__tip">Pinch to zoom · two fingers to pan · tap a pin to read it</p>
      <AnnotationLayerBar v-if="layers.length > 1" v-model:hidden-authors="hiddenAuthors" v-model:show-resolved="showResolved" :layers="layers" />
      <ReviewAnnotationThread
        v-if="selected"
        ref="thread"
        :annotation="selected"
        :fresh="isFresh(selected)"
        :number="selectedNumber"
        variant="panel"
        @close="closeThread"
        @discard="discard"
      />
    </template>
  </div>
</template>
