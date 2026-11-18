<script setup>
import { computed, nextTick, ref, watch } from 'vue';

import AnnotationCanvas from './annotation/AnnotationCanvas.vue';
import RequirementsMarkdown from './RequirementsMarkdown.vue';
import ReviewPrototypeFrame from './ReviewPrototypeFrame.vue';
import { screenChangeChip } from '../../lib/requirements/requirements-packages.js';
import { chipToneClass } from '../../lib/requirements/requirements-topics.js';

// The package's screens as a reviewer meets them: pick a screen, then look at it. Image
// screens open in a zoomable viewer; prototypes run in the sandboxed frame. For
// prototypes, "Check snapshot" shows the picture reviewers would annotate and which
// element a comment at a point would attach to.
const props = defineProps({
  changeById: { default: () => ({}), type: Object },
  directionTitles: { default: () => ({}), type: Object },
  entryUrls: { default: () => ({}), type: Object },
  // Why previews are missing (no grant), shown in place of a screen.
  previewNote: { default: '', type: String },
  screens: { default: () => [], type: Array },
  selectedId: { default: '', type: String },
});

const emit = defineEmits(['update:selectedId']);

const viewerHeading = ref(null);
const frame = ref(null);
const frameReady = ref(false);
const capturing = ref(false);
const snapshot = ref(null);
const snapshotStatus = ref('');
const hintResult = ref(null);
const hinting = ref(false);

const selected = computed(() => props.screens.find((screen) => screen.id === props.selectedId) ?? props.screens[0] ?? null);
const selectedUrl = computed(() => (selected.value ? props.entryUrls?.[selected.value.id] ?? '' : ''));

function kindLabel(screen) {
  return screen?.kind === 'prototype' ? 'Prototype' : 'Image';
}

function select(screenId) {
  emit('update:selectedId', screenId);
}

async function focusViewer() {
  await nextTick();
  viewerHeading.value?.focus({ preventScroll: true });
  viewerHeading.value?.scrollIntoView({ block: 'nearest' });
}

function selectAndFocus(screenId) {
  select(screenId);
  focusViewer();
}

watch(() => selected.value?.id, () => {
  frameReady.value = false;
  capturing.value = false;
  snapshot.value = null;
  snapshotStatus.value = '';
  hintResult.value = null;
});

async function checkSnapshot() {
  // The button stays enabled while a snapshot runs so it keeps keyboard focus.
  if (!frame.value || capturing.value || !frameReady.value) return;
  capturing.value = true;
  snapshot.value = null;
  hintResult.value = null;
  snapshotStatus.value = 'Taking a snapshot…';
  const result = await frame.value.capture();
  capturing.value = false;
  if (result.ok) {
    snapshot.value = result;
    snapshotStatus.value = `Snapshot taken, ${result.width} × ${result.height}.`;
  } else {
    snapshotStatus.value = `The snapshot failed: ${result.reason} Reviewers would annotate a blank frame of this screen with a note instead.`;
  }
}

async function pointAt(event) {
  if (!frame.value || !snapshot.value || hinting.value) return;
  const image = event.currentTarget.querySelector('img');
  const rect = image?.getBoundingClientRect();
  if (!rect || rect.width === 0) return;
  // A keyboard press has no pointer position: use the middle of the snapshot.
  const fromPointer = event.detail > 0 && Number.isFinite(event.clientX);
  const offsetX = fromPointer ? event.clientX - rect.left : rect.width / 2;
  const offsetY = fromPointer ? event.clientY - rect.top : rect.height / 2;
  // Snapshot pixels are frame CSS pixels at scale 1.
  const x = Math.round((offsetX / rect.width) * snapshot.value.width);
  const y = Math.round((offsetY / rect.height) * snapshot.value.height);
  hinting.value = true;
  const result = await frame.value.hint(x, y);
  hinting.value = false;
  hintResult.value = { ...result, x, y };
}

defineExpose({ focusViewer, selectAndFocus });
</script>

<template>
  <div class="rq-screens">
    <ul class="rq-screens__list" aria-label="Screens in this package">
      <li v-for="screen in screens" :key="screen.id">
        <button
          class="rq-screens__item"
          :class="{ 'rq-screens__item--on': selected?.id === screen.id }"
          type="button"
          :aria-pressed="selected?.id === screen.id ? 'true' : 'false'"
          @click="select(screen.id)"
        >
          <i class="bi" :class="screen.kind === 'prototype' ? 'bi-window-stack' : 'bi-image'" aria-hidden="true"></i>
          <span class="rq-screens__name">
            {{ screen.title }}
            <span class="rq-xs rq-muted d-block">{{ kindLabel(screen) }}<template v-if="screen.directionId && directionTitles[screen.directionId]"> · {{ directionTitles[screen.directionId] }}</template></span>
          </span>
          <span v-if="screenChangeChip(changeById[screen.id])" class="rq-chip" :class="chipToneClass(screenChangeChip(changeById[screen.id]).tone)">{{ screenChangeChip(changeById[screen.id]).label }}</span>
        </button>
      </li>
    </ul>

    <div v-if="selected" class="rq-screens__viewer rq-stack">
      <div class="rq-row rq-row--between rq-row--wrap">
        <h4 :id="`rq-screen-${selected.id}`" ref="viewerHeading" class="rq-title rq-title--sm rq-section-heading" tabindex="-1">{{ selected.title }}</h4>
        <div class="rq-row rq-row--tight rq-row--wrap">
          <span class="rq-chip rq-chip--neutral">{{ kindLabel(selected) }}</span>
          <span v-if="selected.directionId && directionTitles[selected.directionId]" class="rq-chip rq-chip--outline">{{ directionTitles[selected.directionId] }}</span>
          <span v-if="screenChangeChip(changeById[selected.id])" class="rq-chip" :class="chipToneClass(screenChangeChip(changeById[selected.id]).tone)">{{ screenChangeChip(changeById[selected.id]).label }}</span>
        </div>
      </div>

      <div v-if="!selectedUrl" class="rq-empty">
        <p><strong>{{ selected.kind === 'prototype' ? 'Prototype unavailable' : 'Image unavailable' }}</strong></p>
        <p class="rq-small">{{ previewNote || 'This screen cannot be shown right now.' }}</p>
      </div>

      <div v-else-if="selected.kind === 'image'" class="rq-screens__image">
        <AnnotationCanvas
          :key="selected.id"
          :height="Number(selected.height) || 800"
          :image-alt="selected.alt || selected.title"
          :image-url="selectedUrl"
          :label="`${selected.title}, zoomable screen image`"
          readonly
          :screen-key="selected.id"
          :width="Number(selected.width) || 1280"
        />
      </div>

      <template v-else>
        <ReviewPrototypeFrame
          :key="selected.id"
          ref="frame"
          :entry-url="selectedUrl"
          :states="selected.states ?? []"
          :title="`${selected.title}, prototype`"
          :viewport="selected.viewport ?? { width: 1280, height: 800 }"
          @status="frameReady = $event === 'ready'"
        />
        <div class="rq-snapcheck rq-stack rq-stack--sm">
          <div class="rq-row rq-row--wrap rq-row--tight">
            <button
              class="ghost-button ghost-button--compact"
              type="button"
              :aria-disabled="!frameReady || capturing ? 'true' : undefined"
              :disabled="!frameReady && !capturing"
              @click="checkSnapshot"
            >
              <i class="bi bi-camera" aria-hidden="true"></i>{{ capturing ? 'Taking snapshot…' : 'Check snapshot' }}
            </button>
            <span class="rq-xs rq-muted">Reviewers annotate a snapshot of what they see. Check that this prototype captures cleanly.</span>
          </div>
          <p class="rq-small mb-0" role="status" data-testid="rq-snapshot-status">{{ snapshotStatus }}</p>
          <figure v-if="snapshot" class="rq-snapcheck__figure">
            <button class="rq-snapcheck__shot" type="button" :aria-busy="hinting ? 'true' : undefined" @click="pointAt">
              <img :src="snapshot.dataUrl" :alt="`Snapshot of ${selected.title}`" :width="snapshot.width" :height="snapshot.height" />
              <span class="visually-hidden">Check which element a comment would attach to. Pointer users click a spot; the keyboard checks the middle.</span>
            </button>
            <figcaption class="rq-xs rq-muted">Click a spot in the snapshot to see which element a comment there would attach to.</figcaption>
          </figure>
          <p v-if="hintResult" class="rq-small mb-0" role="status" data-testid="rq-hint-result">
            <template v-if="hintResult.ok && hintResult.hint">
              At {{ hintResult.x }}, {{ hintResult.y }}: <code>{{ hintResult.hint.tag }}</code>
              <template v-if="hintResult.hint.odinId"> · data-odin-id <code>{{ hintResult.hint.odinId }}</code></template>
              <template v-else> · no data-odin-id nearby</template>
              <template v-if="hintResult.hint.text"> · “{{ hintResult.hint.text }}”</template>
            </template>
            <template v-else-if="hintResult.ok">Nothing is at {{ hintResult.x }}, {{ hintResult.y }}.</template>
            <template v-else>{{ hintResult.reason }}</template>
          </p>
        </div>
      </template>

      <dl class="rq-screens__notes">
        <template v-if="selected.rationale">
          <dt class="rq-eyebrow">Why this screen</dt>
          <dd><RequirementsMarkdown :source="selected.rationale" /></dd>
        </template>
        <template v-if="selected.changeNote">
          <dt class="rq-eyebrow">What changed</dt>
          <dd><RequirementsMarkdown :source="selected.changeNote" /></dd>
        </template>
        <dt class="rq-eyebrow">Description for screen readers</dt>
        <dd class="rq-small">{{ selected.alt }}</dd>
      </dl>
    </div>
  </div>
</template>
