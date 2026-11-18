<script setup>
import { computed, useId } from 'vue';

import RequirementsMarkdown from '../RequirementsMarkdown.vue';
import { NOT_REVIEWED, STANCE_OPTIONS, reviewSteps } from '../../../lib/requirements/review-progress.js';
import { useReviewSession } from '../../../lib/requirements/review-session.js';

// Directions: alternative approaches to compare. The reviewer marks each preferred,
// acceptable, or rejected, and can name elements to keep from it (a remix note).
const session = useReviewSession();
const ids = useId();

const content = computed(() => session.state.content);
const directions = computed(() => content.value?.directions ?? []);
const steps = computed(() => reviewSteps(content.value));
const at = computed(() => steps.value.findIndex((step) => step.id === 'directions'));
const previous = computed(() => steps.value[at.value - 1] ?? null);
const next = computed(() => steps.value[at.value + 1] ?? null);
const disabled = computed(() => !session.canRespond());
const screenTitles = computed(() => new Map((content.value?.screens ?? []).map((screen) => [screen.id, screen.title])));

function stance(direction) {
  return session.state.stances[direction.id]?.stance ?? null;
}

function remix(direction) {
  return session.state.stances[direction.id]?.remix ?? '';
}

function openScreen(screenId) {
  session.goTo({ screenId, stateKey: null, step: 'screens' });
}
</script>

<template>
  <div class="rq-review-page">
    <section class="rq-review-card rq-stack" :aria-labelledby="`${ids}-heading`">
      <div>
        <p class="rq-eyebrow mb-1">Step {{ at + 1 }} · {{ directions.length }} directions</p>
        <h2 :id="`${ids}-heading`" class="rq-title rq-title--lg rq-section-heading" data-rq-review-heading tabindex="-1">Compare the directions</h2>
        <p class="rq-small rq-muted mb-0">Mark each one preferred, acceptable, or rejected. If you like part of a direction you don’t prefer, say what to keep from it.</p>
      </div>
      <p v-if="!session.state.data?.me?.isReviewer" class="rq-notice mb-0">You’re not on this round’s reviewer list, so you can read the directions but not mark them.</p>

      <div class="rq-directions rq-directions--review">
        <article v-for="direction in directions" :key="direction.id" class="rq-direction rq-direction--review" :class="{ [`rq-direction--${stance(direction)}`]: stance(direction) }" :aria-labelledby="`${ids}-${direction.id}`">
          <div class="rq-row rq-row--tight">
            <span class="rq-direction__letter" aria-hidden="true">{{ direction.letter }}</span>
            <h3 :id="`${ids}-${direction.id}`" class="rq-title rq-title--sm"><span class="visually-hidden">Direction {{ direction.letter }}: </span>{{ direction.title }}</h3>
          </div>
          <RequirementsMarkdown :source="direction.summary" />
          <div v-if="direction.tradeoffs">
            <p class="rq-eyebrow mb-1">Trade-offs</p>
            <RequirementsMarkdown :source="direction.tradeoffs" />
          </div>
          <p v-if="direction.screenIds?.length" class="rq-xs mb-0">
            <span class="rq-muted">Screens: </span>
            <template v-for="(screenId, index) in direction.screenIds" :key="screenId">
              <button class="rq-text-action" type="button" @click="openScreen(screenId)">{{ screenTitles.get(screenId) ?? screenId }}</button><template v-if="index < direction.screenIds.length - 1">, </template>
            </template>
          </p>
          <fieldset class="rq-field" :disabled="disabled">
            <legend class="rq-xs">Your view of {{ direction.title }}</legend>
            <div class="rq-seg rq-seg--block rq-seg--stance">
              <label v-for="option in STANCE_OPTIONS" :key="option.value" class="rq-seg__option" :class="`rq-seg__option--${option.value}`">
                <input type="radio" :name="`${ids}-stance-${direction.id}`" :value="option.value" :checked="stance(direction) === option.value" @change="session.setStance(direction.id, option.value)" />
                <span>{{ option.label }}</span>
              </label>
            </div>
            <p class="rq-xs mb-0">
              <button v-if="stance(direction) && !disabled" class="rq-text-action" type="button" :aria-label="`Clear your view of ${direction.title}`" @click="session.setStance(direction.id, null)">Clear</button>
              <span v-else-if="!stance(direction)" class="rq-chip rq-chip--outline">{{ NOT_REVIEWED }}</span>
            </p>
          </fieldset>
          <div class="rq-field">
            <label :for="`${ids}-remix-${direction.id}`" class="rq-xs">Anything to keep from this direction? <span class="rq-muted">Optional</span></label>
            <textarea
              :id="`${ids}-remix-${direction.id}`"
              class="rq-textarea"
              :disabled="disabled"
              maxlength="2000"
              placeholder="For example, “the week calendar”."
              rows="2"
              :value="remix(direction)"
              @blur="session.commitRemix(direction.id)"
              @input="session.setRemix(direction.id, $event.target.value)"
            ></textarea>
            <p v-if="session.isHeld(`direction:${direction.id}`)" class="rq-xs rq-verdict__held mb-0" role="status">Choose preferred, acceptable, or rejected to save this note.</p>
          </div>
        </article>
      </div>

      <div class="rq-row rq-row--between rq-review-card__foot">
        <button v-if="previous" class="ghost-button" type="button" @click="session.goTo({ step: previous.id })">
          <i class="bi bi-arrow-left" aria-hidden="true"></i>{{ previous.label }}
        </button>
        <span v-else></span>
        <button v-if="next" class="primary-button" type="button" @click="session.goTo({ step: next.id })">
          {{ next.label }}<i class="bi bi-arrow-right" aria-hidden="true"></i>
        </button>
      </div>
    </section>
  </div>
</template>
