<script setup>
import { computed, nextTick, ref, useId, watch } from 'vue';

import ReviewAnnotator from './ReviewAnnotator.vue';
import ReviewMarksPanel from './ReviewMarksPanel.vue';
import ReviewPrototypeStage from './ReviewPrototypeStage.vue';
import ReviewVerdictPanel from './ReviewVerdictPanel.vue';
import RequirementsMarkdown from '../RequirementsMarkdown.vue';
import { annotationsOnScreen, surfaceKeyOf } from '../../../lib/requirements/review-annotations.js';
import { progressPercent, reviewSteps } from '../../../lib/requirements/review-progress.js';
import { useReviewSession } from '../../../lib/requirements/review-session.js';

// One screen at a time (sh-review-screen.png): the screen with the annotation tools on the
// left, the reviewer's feedback, the marks list, and "Why this" on the right. On a phone
// (sh-mobile.png) threads sit below the screen and the verdict lives in a bottom sheet.
const props = defineProps({
  phone: { default: false, type: Boolean },
});

const session = useReviewSession();
const ids = useId();

const activeId = ref(null);
const hiddenAuthors = ref([]);
const showResolved = ref(false);
const tab = ref('feedback');
const surface = ref(null);
const detailsOpen = ref(false);
const stage = ref(null);
const annotator = ref(null);

const content = computed(() => session.state.content);
const screens = computed(() => content.value?.screens ?? []);
const screen = computed(() => screens.value.find((entry) => entry.id === session.state.position.screenId) ?? screens.value[0] ?? null);
const index = computed(() => Math.max(0, screens.value.indexOf(screen.value)));
const steps = computed(() => reviewSteps(content.value));
const stepIndex = computed(() => steps.value.findIndex((step) => step.id === 'screens'));
const previousStep = computed(() => steps.value[stepIndex.value - 1] ?? null);
const nextStep = computed(() => steps.value[stepIndex.value + 1] ?? null);
const annotations = computed(() => (screen.value ? annotationsOnScreen(session.state.annotations, screen.value.id) : []));
const markCount = computed(() => annotations.value.filter((annotation) => annotation.status !== 'outdated').length);
const imageBounds = computed(() => ({ height: Number(screen.value?.height) || 800, width: Number(screen.value?.width) || 1280 }));
const isPrototype = computed(() => screen.value?.kind === 'prototype');
const percent = computed(() => progressPercent(session.progress()));
const reviewer = computed(() => Boolean(session.state.data?.me?.isReviewer));
const changeText = computed(() => ({ changed: 'Changed since the last version', new: 'New in this version', unchanged: 'Unchanged since the last version' })[screen.value?.change] ?? '');
const eyebrow = computed(() => {
  const parts = [`Screen ${index.value + 1} of ${screens.value.length}`];
  if (screen.value?.direction) parts.push(`Direction ${screen.value.direction.letter}`);
  if (isPrototype.value) parts.push('Clickable prototype');
  return parts.join(' · ');
});
const tabs = computed(() => [
  { id: 'feedback', label: 'Your feedback' },
  { id: 'marks', label: `Marks · ${markCount.value}` },
  { id: 'why', label: 'Why this' },
]);
const previousLabel = computed(() => (index.value > 0 ? 'Previous' : previousStep.value?.label ?? 'Back'));
const nextLabel = computed(() => (index.value < screens.value.length - 1 ? 'Next screen' : nextStep.value?.id === 'submit' ? 'Review and submit' : nextStep.value?.label ?? 'Next'));

watch(() => screen.value?.id, () => {
  activeId.value = null;
  surface.value = null;
  tab.value = 'feedback';
  detailsOpen.value = false;
});

function goPrevious() {
  if (index.value > 0) session.goTo({ screenId: screens.value[index.value - 1].id, stateKey: null, step: 'screens' });
  else if (previousStep.value) session.goTo({ step: previousStep.value.id });
}

function goNext() {
  if (index.value < screens.value.length - 1) session.goTo({ screenId: screens.value[index.value + 1].id, stateKey: null, step: 'screens' });
  else if (nextStep.value) session.goTo({ step: nextStep.value.id });
}

function onPrototypeState(stateKey) {
  if (session.state.position.stateKey !== stateKey) session.goTo({ stateKey });
}

async function selectMark(id) {
  const annotation = annotations.value.find((entry) => entry.id === id);
  if (!annotation) return;
  if (isPrototype.value) {
    const onSurface = surface.value && surfaceKeyOf(annotation) !== 'image' && (annotation.snapshotFileId ? annotation.snapshotFileId === surface.value.snapshotFileId : annotation.localSnapshotId ? annotation.localSnapshotId === surface.value.localId : surface.value.unavailable && (annotation.stateKey ?? null) === (surface.value.stateKey ?? null));
    if (!onSurface) await stage.value?.openAnnotation(annotation);
  }
  activeId.value = id;
}

async function activateMark(id) {
  await selectMark(id);
  await nextTick();
  if (isPrototype.value) stage.value?.openThread(id);
  else annotator.value?.openThread(id);
}

// A link from Marks and comments (session.focusMark) opens its mark once this screen shows it.
watch(() => [session.state.focusMarkId, screen.value?.id], async ([id]) => {
  if (!id || !annotations.value.some((annotation) => annotation.id === id)) return;
  session.state.focusMarkId = null;
  await nextTick();
  tab.value = 'marks';
  await activateMark(id);
}, { flush: 'post', immediate: true });

function onTabKeydown(event, current) {
  const order = tabs.value.map((entry) => entry.id);
  const at = order.indexOf(current);
  let next = null;
  if (event.key === 'ArrowRight') next = order[(at + 1) % order.length];
  else if (event.key === 'ArrowLeft') next = order[(at - 1 + order.length) % order.length];
  else if (event.key === 'Home') next = order[0];
  else if (event.key === 'End') next = order.at(-1);
  if (!next) return;
  event.preventDefault();
  tab.value = next;
  nextTick(() => document.getElementById(`${ids}-tab-${next}`)?.focus());
}
</script>

<template>
  <div v-if="screen" class="rq-screenstep" :class="{ 'rq-screenstep--phone': phone }">
    <template v-if="!phone">
      <section class="rq-stage-area" :aria-label="`${screen.title}, ${isPrototype ? 'prototype' : 'screen'}`">
        <ReviewPrototypeStage
          v-if="isPrototype"
          ref="stage"
          v-model:active-id="activeId"
          v-model:hidden-authors="hiddenAuthors"
          v-model:show-resolved="showResolved"
          v-model:surface="surface"
          :annotations="annotations"
          :resume-state-key="session.state.position.stateKey || ''"
          :screen="screen"
          @activate="activateMark"
          @state="onPrototypeState"
        />
        <ReviewAnnotator
          v-else
          ref="annotator"
          v-model:active-id="activeId"
          v-model:hidden-authors="hiddenAuthors"
          v-model:show-resolved="showResolved"
          :annotations="annotations"
          :bounds="imageBounds"
          :image-alt="screen.alt || screen.title"
          :image-url="screen.entryUrl || ''"
          :label="`${screen.title}, screen to annotate`"
          :screen-id="screen.id"
          :surface-key="screen.id"
        />
      </section>

      <aside class="rq-side" :aria-labelledby="`${ids}-heading`">
        <header class="rq-side__head">
          <p class="rq-eyebrow mb-0">{{ eyebrow }}</p>
          <h2 :id="`${ids}-heading`" class="rq-title rq-title--md rq-section-heading" data-rq-review-heading tabindex="-1">{{ screen.title }}</h2>
        </header>
        <div class="rq-side__tabs" role="tablist" aria-label="Screen panels">
          <button
            v-for="entry in tabs"
            :id="`${ids}-tab-${entry.id}`"
            :key="entry.id"
            class="rq-side__tab"
            :class="{ 'rq-side__tab--on': tab === entry.id }"
            type="button"
            role="tab"
            :aria-selected="tab === entry.id ? 'true' : 'false'"
            :aria-controls="`${ids}-panel`"
            :tabindex="tab === entry.id ? 0 : -1"
            @click="tab = entry.id"
            @keydown="onTabKeydown($event, entry.id)"
          >{{ entry.label }}</button>
        </div>
        <div :id="`${ids}-panel`" class="rq-side__body" role="tabpanel" :aria-labelledby="`${ids}-tab-${tab}`" tabindex="0">
          <template v-if="tab === 'feedback'">
            <div v-if="screen.rationale" class="rq-panel rq-panel--soft rq-why-card">
              <p class="rq-eyebrow mb-1">Why this screen</p>
              <RequirementsMarkdown :source="screen.rationale" />
            </div>
            <p v-if="!reviewer" class="rq-notice mb-0">You’re not on this round’s reviewer list, so verdicts are for invited reviewers. You can still mark up the screen and comment.</p>
            <ReviewVerdictPanel v-else :screen="screen" />
          </template>
          <ReviewMarksPanel
            v-else-if="tab === 'marks'"
            :active-id="activeId"
            :annotations="annotations"
            :hidden-authors="hiddenAuthors"
            :show-resolved="showResolved"
            @activate="activateMark"
            @select="selectMark"
          />
          <div v-else class="rq-stack">
            <div v-if="screen.rationale">
              <h3 class="rq-eyebrow mb-1">Why this screen</h3>
              <RequirementsMarkdown :source="screen.rationale" />
            </div>
            <div v-if="screen.changeNote || changeText">
              <h3 class="rq-eyebrow mb-1">What changed</h3>
              <p v-if="changeText" class="rq-small mb-1">{{ changeText }}.</p>
              <RequirementsMarkdown :source="screen.changeNote" />
            </div>
            <div v-if="screen.direction">
              <h3 class="rq-eyebrow mb-1">Direction {{ screen.direction.letter }} · {{ screen.direction.title }}</h3>
              <RequirementsMarkdown :source="screen.direction.summary" />
            </div>
            <div>
              <h3 class="rq-eyebrow mb-1">What it shows</h3>
              <p class="rq-small mb-0">{{ screen.alt || screen.title }}</p>
            </div>
          </div>
        </div>
        <footer class="rq-side__foot">
          <button class="ghost-button ghost-button--compact" type="button" @click="goPrevious">
            <i class="bi bi-arrow-left" aria-hidden="true"></i>{{ previousLabel }}
          </button>
          <button class="primary-button primary-button--compact" type="button" @click="goNext">
            {{ nextLabel }}<i class="bi bi-arrow-right" aria-hidden="true"></i>
          </button>
        </footer>
      </aside>
    </template>

    <template v-else>
      <div class="rq-phonebar">
        <span class="rq-chip rq-chip--solid">Screen {{ index + 1 }} of {{ screens.length }}</span>
        <span class="rq-review-meter rq-grow" role="img" :aria-label="`${percent}% of the review done`"><span :style="{ width: `${percent}%` }"></span></span>
        <span class="rq-xs rq-muted" aria-hidden="true">{{ percent }}%</span>
      </div>
      <h2 :id="`${ids}-heading`" class="rq-title rq-title--md rq-section-heading rq-phone-title" data-rq-review-heading tabindex="-1">{{ screen.title }}</h2>

      <ReviewPrototypeStage
        v-if="isPrototype"
        ref="stage"
        v-model:active-id="activeId"
        v-model:hidden-authors="hiddenAuthors"
        v-model:show-resolved="showResolved"
        v-model:surface="surface"
        :annotations="annotations"
        phone
        :resume-state-key="session.state.position.stateKey || ''"
        :screen="screen"
        @activate="activateMark"
        @state="onPrototypeState"
      />
      <ReviewAnnotator
        v-else
        ref="annotator"
        v-model:active-id="activeId"
        v-model:hidden-authors="hiddenAuthors"
        v-model:show-resolved="showResolved"
        :annotations="annotations"
        :bounds="imageBounds"
        :image-alt="screen.alt || screen.title"
        :image-url="screen.entryUrl || ''"
        :label="`${screen.title}, screen to annotate`"
        phone
        :screen-id="screen.id"
        :surface-key="screen.id"
      />

      <details class="rq-phone-details">
        <summary>Marks · {{ markCount }}</summary>
        <ReviewMarksPanel
          :active-id="activeId"
          :annotations="annotations"
          :hidden-authors="hiddenAuthors"
          :show-resolved="showResolved"
          @activate="activateMark"
          @select="selectMark"
        />
      </details>
      <details v-if="screen.rationale || screen.changeNote" class="rq-phone-details">
        <summary>Why this screen</summary>
        <RequirementsMarkdown :source="screen.rationale" />
        <RequirementsMarkdown :source="screen.changeNote" />
      </details>

      <section class="rq-sheet" :aria-label="`Your verdict on ${screen.title}`">
        <div class="rq-sheet__grab" aria-hidden="true"></div>
        <template v-if="reviewer">
          <div class="rq-row rq-row--between">
            <strong class="rq-small">Overall, {{ isPrototype ? 'this flow' : 'this screen' }}</strong>
            <button class="rq-text-action" type="button" :aria-expanded="detailsOpen ? 'true' : 'false'" :aria-controls="`${ids}-details`" @click="detailsOpen = !detailsOpen">
              Aspects &amp; notes <span aria-hidden="true">{{ detailsOpen ? '⌄' : '›' }}</span>
            </button>
          </div>
          <ReviewVerdictPanel class="rq-sheet__overall" part="overall" :screen="screen" />
          <div v-show="detailsOpen" :id="`${ids}-details`" class="rq-sheet__details">
            <ReviewVerdictPanel part="details" :screen="screen" />
          </div>
        </template>
        <p v-else class="rq-xs rq-muted mb-0">Verdicts are for invited reviewers. You can still mark up the screen and comment.</p>
        <div class="rq-sheet__nav">
          <button class="ghost-button rq-sheet__back" type="button" :aria-label="previousLabel" @click="goPrevious">
            <i class="bi bi-arrow-left" aria-hidden="true"></i>
          </button>
          <button class="primary-button rq-grow" type="button" @click="goNext">
            {{ nextLabel }}<i class="bi bi-arrow-right" aria-hidden="true"></i>
          </button>
        </div>
      </section>
    </template>
  </div>
</template>
