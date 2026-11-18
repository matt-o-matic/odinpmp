<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, useSlots, watch } from 'vue';

import ReviewDirectionsStep from './ReviewDirectionsStep.vue';
import ReviewOverviewStep from './ReviewOverviewStep.vue';
import ReviewQuestionsStep from './ReviewQuestionsStep.vue';
import ReviewSaveStatus from './ReviewSaveStatus.vue';
import ReviewScreenStep from './ReviewScreenStep.vue';
import ReviewStepBar from './ReviewStepBar.vue';
import ReviewSubmitStep from './ReviewSubmitStep.vue';
import { formatShortDate } from '../../../lib/requirements/requirements-time.js';
import { reviewSteps, stepDone } from '../../../lib/requirements/review-progress.js';
import { REVIEW_MARKS_LINK_KEY, REVIEW_SESSION_KEY, createReviewSession } from '../../../lib/requirements/review-session.js';
import { useMediaQuery } from '../../../lib/requirements/review-viewport.js';

// The guided review, shared by the client portal and team members in the app. The
// adapter decides which API it talks to; everything else is the same: Overview, Directions,
// Screens, Questions, Submit, resuming where the reviewer left off and saving as they go.
// `focusMark` opens on one mark instead; `marksLink` (team only) links each mark to the
// round's Marks and comments view.
const props = defineProps({
  adapter: { required: true, type: Object },
  asker: { default: '', type: String },
  audience: { default: 'portal', type: String },
  focusMark: { default: '', type: String },
  marksLink: { default: null, type: Function },
});

const emit = defineEmits(['focused', 'link-problem', 'loaded']);
const slots = useSlots();

const session = createReviewSession({ adapter: props.adapter, onLinkProblem: (error) => emit('link-problem', error) });
provide(REVIEW_SESSION_KEY, session);
provide(REVIEW_MARKS_LINK_KEY, props.marksLink);

const root = ref(null);
const phone = useMediaQuery();
const state = session.state;

const steps = computed(() => (state.content ? reviewSteps(state.content) : []));
const step = computed(() => state.position.step);
const done = computed(() => {
  const progress = session.progress();
  return steps.value.filter((entry) => stepDone(entry.id, { progress, submittedAt: state.submittedAt, visited: state.visited })).map((entry) => entry.id);
});
const screens = computed(() => state.content?.screens ?? []);
const screen = computed(() => screens.value.find((entry) => entry.id === state.position.screenId) ?? screens.value[0] ?? null);
const screenIndex = computed(() => Math.max(0, screens.value.indexOf(screen.value)));
const round = computed(() => state.data?.round ?? null);
const title = computed(() => (round.value ? `Round ${round.value.number} · ${state.content?.title ?? ''}` : 'Review'));
const meta = computed(() => {
  if (!round.value) return '';
  const version = `package v${round.value.packageVersion ?? '?'}`;
  if (step.value === 'screens' && screen.value) {
    const parts = [screen.value.title];
    if (screen.value.direction) parts.push(`Direction ${screen.value.direction.letter}`);
    parts.push(screen.value.kind === 'prototype' ? 'clickable prototype' : 'image');
    parts.push(version);
    return parts.join(' · ');
  }
  return `Round ${round.value.number} · ${version}`;
});
const closedNote = computed(() => {
  if (!round.value || !session.readOnly()) return '';
  const when = round.value.closedAt ? ` on ${formatShortDate(round.value.closedAt)}` : '';
  return `This round closed${when}. Its feedback is read-only.`;
});
const hasHeader = computed(() => Boolean(slots.header));
const showStepBar = computed(() => state.loaded);

function go(stepId) {
  session.goTo({ step: stepId });
}

function focusHeading() {
  const target = root.value?.querySelector('[data-rq-review-heading]');
  target?.focus({ preventScroll: false });
}

watch(() => state.moves, async () => {
  await nextTick();
  await nextTick();
  focusHeading();
});

function onBeforeUnload(event) {
  if (session.autosave.pendingKeys().size === 0 && state.heldKeys.length === 0) return;
  session.flushAll();
  event.preventDefault();
  event.returnValue = '';
}

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload);
  await session.load();
  if (state.loaded) {
    session.startLive();
    emit('loaded', state.data);
    if (props.focusMark) emit('focused', session.focusMark(props.focusMark));
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  session.flushAll();
  session.dispose();
});

defineExpose({ session });
</script>

<template>
  <div
    ref="root"
    class="rq-review"
    :class="[`rq-review--${audience}`, { 'rq-review--phone': phone, 'rq-review--canvas': step === 'screens' && !phone && state.loaded }]"
    data-testid="rq-guided-review"
  >
    <slot name="header" :phone="phone" :retry="session.retry" :round="round" :save="state.save" :title="title"></slot>

    <ReviewStepBar
      v-if="showStepBar"
      :current="step"
      :done="done"
      :screen-count="screens.length"
      :screen-index="screenIndex"
      :steps="steps"
      @go="go"
    >
      <template #meta>
        <span v-if="!phone" class="rq-xs rq-muted rq-steps__meta">{{ meta }}</span>
        <ReviewSaveStatus v-if="!hasHeader && !phone" :status="state.save" @retry="session.retry()" />
      </template>
    </ReviewStepBar>
    <div v-if="!hasHeader && phone && state.loaded" class="rq-review__statusrow">
      <span class="rq-xs rq-muted">{{ title }}</span>
      <ReviewSaveStatus compact :status="state.save" @retry="session.retry()" />
    </div>

    <p v-if="closedNote" class="rq-review__banner" role="note"><i class="bi bi-lock" aria-hidden="true"></i>{{ closedNote }}</p>
    <div v-if="state.rejection" class="error-banner rq-review__banner rq-row rq-row--between" role="alert">
      <span>{{ state.rejection }} The latest saved version is shown.</span>
      <button class="rq-text-action" type="button" @click="state.rejection = ''">Dismiss</button>
    </div>

    <div class="rq-review__body">
      <div v-if="state.loading && !state.loaded" class="rq-review-page">
        <p class="rq-review-card rq-small rq-muted mb-0" role="status">Loading the review…</p>
      </div>
      <div v-else-if="state.notFound" class="rq-review-page">
        <section class="rq-review-card rq-stack">
          <h2 class="rq-title rq-title--md rq-section-heading" data-rq-review-heading tabindex="-1">This round isn’t available</h2>
          <p class="rq-small mb-0">It may have been withdrawn, or you may not be on its reviewer list.</p>
          <slot name="not-found"></slot>
        </section>
      </div>
      <div v-else-if="state.loadError" class="rq-review-page">
        <section class="rq-review-card rq-stack">
          <h2 class="rq-title rq-title--md rq-section-heading" data-rq-review-heading tabindex="-1">The review didn’t load</h2>
          <p class="error-banner mb-0" role="alert">{{ state.loadError }}</p>
          <div><button class="ghost-button" type="button" @click="session.load()">Try again</button></div>
        </section>
      </div>
      <template v-else-if="state.loaded">
        <ReviewOverviewStep v-if="step === 'overview'" :asker="asker" />
        <ReviewDirectionsStep v-else-if="step === 'directions'" />
        <ReviewScreenStep v-else-if="step === 'screens'" :phone="phone" />
        <ReviewQuestionsStep v-else-if="step === 'questions'" />
        <ReviewSubmitStep v-else-if="step === 'submit'" />
      </template>
    </div>
  </div>
</template>
