<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import AnnotationLayerBar from '../annotation/AnnotationLayerBar.vue';
import AnnotationOverlay from '../annotation/AnnotationOverlay.vue';
import ReviewAnnotator from './ReviewAnnotator.vue';
import ReviewPrototypeFrame from '../ReviewPrototypeFrame.vue';
import {
  annotationLayers,
  annotationsOnLiveState,
  annotationsOnSurface,
  editorHiddenAuthors,
  hintPoint,
  liveStateKeys,
  reviewActor,
  scrollOffset,
  snapshotSurfaceKeys,
  toCanvasMark,
} from '../../../lib/requirements/review-annotations.js';
import { matchDeclaredState } from '../../../lib/requirements/review-bridge.js';
import { useReviewSession } from '../../../lib/requirements/review-session.js';

// A prototype screen (sh-review-prototype.png). Browse passes input to the sandboxed frame;
// Annotate asks the bridge for a snapshot of what the reviewer sees and opens the editor
// over it, so marks stay attached to exactly that picture. The first mark asks the frame
// which element sits under it. When the snapshot fails, the reviewer marks up a blank frame
// of the declared viewport, saved with a "Snapshot unavailable" note (plan.md, Failure and
// recovery). The frame stays mounted underneath while annotating, so hints still work.
// While browsing, the marks made on the state the prototype shows sit over it, shifted by
// how far the page has scrolled since each snapshot; a pin opens its snapshot and thread.
const props = defineProps({
  annotations: { default: () => [], type: Array },
  phone: { default: false, type: Boolean },
  resumeStateKey: { default: '', type: String },
  screen: { required: true, type: Object },
});

const emit = defineEmits(['activate', 'state']);

const activeId = defineModel('activeId', { default: null, type: String });
const hiddenAuthors = defineModel('hiddenAuthors', { default: () => [], type: Array });
const showResolved = defineModel('showResolved', { default: false, type: Boolean });
// null while browsing; a snapshot surface while annotating.
const surface = defineModel('surface', { default: null, type: Object });

const session = useReviewSession();
const frame = ref(null);
const annotator = ref(null);
const frameState = ref(null);
const frameStatus = ref('connecting');
const frameScroll = ref(null);
const capturing = ref(false);
const opening = ref(false);
const notice = ref('');
let resumed = false;
let objectUrl = '';

const viewport = computed(() => ({
  height: Math.max(1, Number(props.screen.viewport?.height) || 800),
  width: Math.max(1, Number(props.screen.viewport?.width) || 1280),
}));
const states = computed(() => (Array.isArray(props.screen.states) ? props.screen.states : []));
const currentKey = computed(() => matchDeclaredState(frameState.value, states.value) || frameState.value?.key || '');
const currentLabel = computed(() => states.value.find((entry) => entry.key === currentKey.value)?.label ?? '');
const annotating = computed(() => Boolean(surface.value));
const canAnnotate = computed(() => session.canAnnotate());
const surfaceAnnotations = computed(() => annotationsOnSurface(props.annotations, { screenId: props.screen.id, snapshot: surface.value }));
const surfaceLabel = computed(() => states.value.find((entry) => entry.key === surface.value?.stateKey)?.label || surface.value?.stateKey || props.screen.title);
const surfaceKey = computed(() => `${props.screen.id}:${snapshotSurfaceKeys(surface.value).join('|')}`);
const imageUrl = computed(() => surface.value?.imageUrl || surface.value?.dataUrl || '');
const categoryLabels = computed(() => Object.fromEntries((session.state.content?.dimensions ?? []).map((dimension) => [dimension.key, dimension.label])));
const liveAnnotations = computed(() => (annotating.value ? [] : annotationsOnLiveState(props.annotations, { screenId: props.screen.id, stateKeys: liveStateKeys(frameState.value, currentKey.value) })));
const liveMarks = computed(() => liveAnnotations.value.map((annotation) => ({ ...toCanvasMark(annotation, { bounds: viewport.value, readOnly: true }), offset: scrollOffset(annotation, frameScroll.value) })));
const liveLayers = computed(() => annotationLayers(liveAnnotations.value, { actor: reviewActor(session.state.data?.me), readOnly: !canAnnotate.value }));

function revokeObjectUrl() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = '';
}

function onReady(event) {
  frameState.value = event.state ?? null;
  frameScroll.value = event.scroll ?? null;
  if (!resumed && props.resumeStateKey && states.value.some((entry) => entry.key === props.resumeStateKey)) {
    resumed = true;
    if (currentKey.value !== props.resumeStateKey) frame.value?.gotoState(props.resumeStateKey);
  }
  resumed = true;
}

function onState(state) {
  frameState.value = state;
}

watch(currentKey, (key) => {
  if (key) emit('state', key);
});

function browse() {
  surface.value = null;
  activeId.value = null;
  notice.value = '';
  revokeObjectUrl();
}

function gotoState(key) {
  if (annotating.value) browse();
  frame.value?.gotoState(key);
}

/** Annotate: freeze what the reviewer sees now. */
async function annotate() {
  if (capturing.value || !canAnnotate.value) return;
  capturing.value = true;
  notice.value = 'Taking a snapshot of the prototype…';
  activeId.value = null;
  revokeObjectUrl();
  const stateKey = currentKey.value || null;
  const result = frame.value ? await frame.value.capture() : { ok: false, reason: 'The prototype is not loaded.' };
  capturing.value = false;
  if (result.ok) {
    const snapshot = session.addSnapshot({ dataUrl: result.dataUrl, height: result.height, stateKey: result.stateKey && states.value.some((entry) => entry.key === result.stateKey) ? result.stateKey : stateKey, width: result.width });
    surface.value = { ...snapshot, live: true, scroll: result.scroll ? { x: result.scroll.x, y: result.scroll.y } : null };
    notice.value = '';
  } else {
    surface.value = { height: viewport.value.height, live: false, reason: result.reason || 'The snapshot failed.', stateKey, unavailable: true, width: viewport.value.width };
    notice.value = '';
  }
}

async function measure(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ height: image.naturalHeight, width: image.naturalWidth });
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** Opens the surface an existing mark sits on, from the marks list. */
async function openAnnotation(annotation) {
  if (!annotation) return;
  notice.value = '';
  if (annotation.anchor?.snapshotUnavailable && !annotation.snapshotFileId) {
    revokeObjectUrl();
    surface.value = { height: viewport.value.height, live: false, stateKey: annotation.stateKey ?? null, unavailable: true, width: viewport.value.width };
    activeId.value = annotation.id;
    return;
  }
  if (surface.value && snapshotSurfaceKeys(surface.value).some((key) => key === `snapshot:${annotation.snapshotFileId}` || key === `local:${annotation.localSnapshotId}`)) {
    activeId.value = annotation.id;
    return;
  }
  if (!annotation.snapshotUrl) {
    notice.value = `Mark ${annotation.number} has no saved snapshot, so it can’t be shown on the screen.`;
    return;
  }
  opening.value = true;
  notice.value = 'Opening the snapshot…';
  try {
    const blob = await session.loadSnapshot(annotation.snapshotUrl);
    revokeObjectUrl();
    objectUrl = URL.createObjectURL(blob);
    const size = (await measure(objectUrl)) ?? viewport.value;
    surface.value = { height: size.height, imageUrl: objectUrl, live: false, scroll: annotation.anchor?.scroll ?? null, snapshotFileId: annotation.snapshotFileId, stateKey: annotation.stateKey ?? null, width: size.width };
    activeId.value = annotation.id;
    notice.value = '';
  } catch {
    notice.value = 'That snapshot couldn’t be loaded. Try again.';
  } finally {
    opening.value = false;
  }
}

/** Which element sits under a new mark: only on the live snapshot, where the frame still shows it. */
function hintFor(shapes) {
  if (!surface.value?.live || !frame.value) return null;
  const point = hintPoint(shapes);
  if (!point) return null;
  return frame.value.hint(point.x, point.y).then((result) => (result?.ok ? result.hint : null));
}

watch(() => props.screen.id, () => {
  browse();
  frameState.value = null;
  frameScroll.value = null;
  resumed = false;
});

onBeforeUnmount(revokeObjectUrl);

defineExpose({ annotate, browse, openAnnotation, openThread: (id) => annotator.value?.openThread(id) });
</script>

<template>
  <div class="rq-review-proto" :class="{ 'rq-review-proto--annotating': annotating }">
    <div class="rq-review-proto__bar">
      <div class="rq-modeseg" role="group" aria-label="Prototype mode">
        <button class="rq-modeseg__option" :class="{ 'rq-modeseg__option--on': !annotating }" type="button" :aria-pressed="!annotating ? 'true' : 'false'" @click="browse">
          <i class="bi bi-hand-index" aria-hidden="true"></i>Browse
        </button>
        <button
          v-if="canAnnotate"
          class="rq-modeseg__option"
          :class="{ 'rq-modeseg__option--on': annotating }"
          type="button"
          :aria-pressed="annotating ? 'true' : 'false'"
          :aria-busy="capturing ? 'true' : undefined"
          @click="annotating ? null : annotate()"
        >
          <i class="bi bi-pencil-square" aria-hidden="true"></i>{{ capturing ? 'Taking snapshot…' : 'Annotate' }}
        </button>
      </div>
      <span class="rq-grow"></span>
      <template v-if="states.length">
        <span :id="`rq-proto-states-${screen.id}`" class="rq-xs rq-review-proto__label">States</span>
        <div class="rq-proto__states" role="group" :aria-labelledby="`rq-proto-states-${screen.id}`">
          <button
            v-for="entry in states"
            :key="entry.key"
            class="rq-proto__state"
            :class="{ 'rq-proto__state--on': (annotating ? surface?.stateKey : currentKey) === entry.key }"
            type="button"
            :aria-pressed="(annotating ? surface?.stateKey : currentKey) === entry.key ? 'true' : 'false'"
            :disabled="frameStatus !== 'ready'"
            @click="gotoState(entry.key)"
          >
            <i v-if="(annotating ? surface?.stateKey : currentKey) === entry.key" class="bi bi-check2" aria-hidden="true"></i>{{ entry.label }}
          </button>
        </div>
      </template>
    </div>

    <p class="rq-xs rq-review-proto__label mb-0" role="status">{{ notice }}</p>

    <div v-if="!annotating && liveMarks.length" class="rq-review-proto__layers">
      <AnnotationLayerBar v-model:hidden-authors="hiddenAuthors" v-model:show-resolved="showResolved" :layers="liveLayers" />
      <span class="rq-xs rq-muted">Select a pin to open its snapshot and thread.</span>
    </div>

    <div class="rq-review-proto__body">
      <ReviewPrototypeFrame
        :key="screen.id"
        ref="frame"
        class="rq-review-proto__frame"
        :class="{ 'rq-review-proto__frame--hidden': annotating }"
        :entry-url="screen.entryUrl || ''"
        :show-states="false"
        :states="states"
        :title="`${screen.title}, clickable prototype`"
        :viewport="viewport"
        @ready="onReady"
        @scroll="frameScroll = $event"
        @state="onState"
        @status="frameStatus = $event"
        @viewport="frameScroll = $event.scroll"
      >
        <template v-if="!annotating && liveMarks.length" #overlay="{ scale }">
          <AnnotationOverlay
            :active-id="activeId"
            :category-labels="categoryLabels"
            :height="viewport.height"
            :hidden-authors="editorHiddenAuthors(hiddenAuthors)"
            :label="`Marks on ${currentLabel || screen.title}`"
            :marks="liveMarks"
            :scale="scale"
            :show-resolved="showResolved"
            :width="viewport.width"
            @pin-click="emit('activate', $event)"
          />
        </template>
      </ReviewPrototypeFrame>

      <div v-if="annotating" class="rq-review-proto__annotate">
        <div class="rq-snapbanner" :class="{ 'rq-snapbanner--warn': surface.unavailable }">
          <i class="bi" :class="surface.unavailable ? 'bi-exclamation-triangle' : 'bi-camera'" aria-hidden="true"></i>
          <span class="rq-grow">
            <template v-if="surface.unavailable">
              <strong>Snapshot unavailable.</strong> {{ surface.reason ? `${surface.reason} ` : '' }}You can mark up a blank {{ surface.width }} × {{ surface.height }} frame of this screen instead. Your marks are saved with that note.
            </template>
            <template v-else-if="surface.live">
              Annotating a snapshot of <strong>{{ surfaceLabel }}</strong>. The prototype is paused; your marks stay attached to exactly what you see.
            </template>
            <template v-else>
              Showing a saved snapshot of <strong>{{ surfaceLabel }}</strong> with the marks made on it.
            </template>
          </span>
          <button class="rq-snapbanner__back" type="button" @click="browse">Back to browsing</button>
        </div>
        <ReviewAnnotator
          ref="annotator"
          v-model:active-id="activeId"
          v-model:hidden-authors="hiddenAuthors"
          v-model:show-resolved="showResolved"
          :annotations="surfaceAnnotations"
          :bounds="{ height: surface.height, width: surface.width }"
          :hint-for="hintFor"
          :image-alt="`Snapshot of ${screen.title}, ${surfaceLabel}`"
          :image-url="imageUrl"
          :label="`${screen.title}, snapshot of ${surfaceLabel}`"
          :phone="phone"
          :screen-id="screen.id"
          :snapshot="surface"
          :surface-key="surfaceKey"
          unavailable-text="Snapshot unavailable"
        />
      </div>
    </div>
  </div>
</template>
