<script setup>
import { computed, nextTick, ref, useId } from 'vue';

import { countMarksByScreen } from '../../../lib/requirements/review-annotations.js';
import { NOT_REVIEWED, buildSubmitSummary, reviewSteps, verdictChipClass } from '../../../lib/requirements/review-progress.js';
import { formatDateTime } from '../../../lib/requirements/requirements-time.js';
import { useReviewSession } from '../../../lib/requirements/review-session.js';

// Before you send it (sh-submit.png): what the reviewer is telling the team. Anything left
// untouched is shown as "Not reviewed" with a way back to it. Submitting records the time;
// the reviewer can keep commenting, and change answers, until the round closes.
const session = useReviewSession();
const ids = useId();
const confirmation = ref(null);

const content = computed(() => session.state.content);
const steps = computed(() => reviewSteps(content.value));
const at = computed(() => steps.value.findIndex((step) => step.id === 'submit'));
const previous = computed(() => steps.value[at.value - 1] ?? null);
const summary = computed(() => buildSubmitSummary({
  answers: session.state.answers,
  content: content.value,
  marksByScreen: countMarksByScreen(session.state.annotations),
  stances: session.state.stances,
  verdicts: session.state.verdicts,
}));
const reviewer = computed(() => Boolean(session.state.data?.me?.isReviewer));
const readOnly = computed(() => session.readOnly());
const submittedAt = computed(() => session.state.submittedAt);
const thumbs = computed(() => new Map((content.value?.screens ?? []).map((screen) => [screen.id, screen.kind === 'image' ? screen.entryUrl : ''])));

function openScreen(screenId) {
  session.goTo({ screenId, stateKey: null, step: 'screens' });
}

async function submit() {
  const ok = await session.submit();
  if (ok) {
    await nextTick();
    confirmation.value?.focus();
  }
}
</script>

<template>
  <div class="rq-review-page">
    <section class="rq-review-card rq-stack" :aria-labelledby="`${ids}-heading`">
      <div>
        <p class="rq-eyebrow mb-1">Before you send it</p>
        <h2 :id="`${ids}-heading`" class="rq-title rq-title--lg rq-section-heading" data-rq-review-heading tabindex="-1">Here’s what you’re telling the team</h2>
      </div>

      <div v-if="submittedAt" ref="confirmation" class="rq-submitted" tabindex="-1" role="status" data-testid="rq-submitted">
        <i class="bi bi-check2-circle" aria-hidden="true"></i>
        <span>
          <strong>Review sent {{ formatDateTime(submittedAt) }}.</strong>
          <template v-if="!readOnly"> You can keep commenting and change your answers until the round closes. Changes keep saving, and the team sees the latest version.</template>
        </span>
      </div>

      <div v-if="summary.directions.length" class="rq-panel rq-panel--soft rq-row rq-row--top">
        <i class="bi bi-signpost-split rq-submit__icon" aria-hidden="true"></i>
        <div class="rq-grow rq-small">
          <strong>Direction:</strong> {{ summary.directionLine }}
          <ul v-if="summary.remixes.length" class="rq-submit__remixes">
            <li v-for="entry in summary.remixes" :key="entry.id">From {{ entry.letter }} · {{ entry.title }}, keep: “{{ entry.remix }}”</li>
          </ul>
        </div>
        <button class="rq-text-action" type="button" @click="session.goTo({ step: 'directions' })">Change<span class="visually-hidden"> your direction choices</span></button>
      </div>

      <div v-if="summary.screens.length">
        <h3 class="rq-eyebrow mb-1">Screens · {{ summary.screens.length - summary.notReviewedScreens }} of {{ summary.screens.length }} reviewed</h3>
        <ul class="rq-submit__screens">
          <li v-for="screen in summary.screens" :key="screen.id" class="rq-submit__screen" :class="{ 'rq-submit__screen--todo': screen.notReviewed }">
            <span class="rq-submit__thumb" aria-hidden="true">
              <img v-if="thumbs.get(screen.id)" :src="thumbs.get(screen.id)" alt="" loading="lazy" />
              <i v-else class="bi" :class="screen.kind === 'prototype' ? 'bi-window-stack' : 'bi-image'"></i>
            </span>
            <span class="rq-grow">
              <strong>{{ screen.title }}</strong><span v-if="screen.kind === 'prototype'" class="rq-xs rq-muted"> prototype</span>
              <span class="rq-xs rq-muted d-block">{{ screen.detail }}</span>
            </span>
            <span class="rq-chip" :class="verdictChipClass(screen.overall)">{{ screen.notReviewed ? NOT_REVIEWED : screen.label }}</span>
            <button
              class="rq-text-action"
              :class="{ 'rq-submit__review-now': screen.notReviewed }"
              type="button"
              @click="openScreen(screen.id)"
            >{{ screen.notReviewed ? 'Review now' : 'Edit' }}<span class="visually-hidden"> {{ screen.title }}</span></button>
          </li>
        </ul>
      </div>

      <div v-if="summary.questions.length">
        <h3 class="rq-eyebrow mb-1">Questions · {{ summary.answeredCount }} of {{ summary.questions.length }} answered</h3>
        <ul class="rq-submit__questions rq-small">
          <li v-for="question in summary.questions" :key="question.id" :class="{ 'rq-muted': !question.answered }">
            <i class="bi" :class="question.answered ? 'bi-check2 rq-submit__ok' : 'bi-dash-circle'" aria-hidden="true"></i>
            <span>
              {{ question.prompt }}
              <template v-if="question.answered"><span class="rq-muted"> → {{ question.text }}</span></template>
              <template v-else> · not answered</template>
            </span>
          </li>
        </ul>
      </div>

      <div class="rq-panel rq-panel--soft rq-small">
        <p class="mb-1"><i class="bi bi-info-circle me-1" aria-hidden="true"></i>Your answers post to the related questions, where the team and the Odin summary will see them, credited to you.</p>
        <p class="mb-0">Anything you skipped stays <strong>Not reviewed</strong>. You can keep commenting after you submit, until the round closes.</p>
      </div>

      <p v-if="session.state.submitError" class="error-banner mb-0" role="alert">{{ session.state.submitError }}</p>
      <p v-if="!reviewer" class="rq-notice mb-0">Only invited reviewers submit a review. Your marks and comments are already saved.</p>
      <p v-else-if="readOnly" class="rq-notice mb-0">This round is closed, so it can’t be submitted.</p>

      <div class="rq-row rq-row--between rq-review-card__foot">
        <button v-if="previous" class="ghost-button" type="button" @click="session.goTo({ step: previous.id })">
          <i class="bi bi-arrow-left" aria-hidden="true"></i>Back to {{ previous.label.toLowerCase() }}
        </button>
        <span v-else></span>
        <button v-if="reviewer && !readOnly && !submittedAt" class="primary-button" type="button" :disabled="session.state.submitting" @click="submit">
          {{ session.state.submitting ? 'Submitting…' : 'Submit review' }}
        </button>
      </div>
    </section>
  </div>
</template>
