<script setup>
import { computed, useId } from 'vue';

import { ASPECT_OPTIONS, NOT_REVIEWED, VERDICT_OPTIONS, aspectLabel } from '../../../lib/requirements/review-progress.js';
import { useReviewSession } from '../../../lib/requirements/review-session.js';

// The reviewer's verdict on one screen: overall Keep / Keep with changes / Change /
// Undecided, optional aspects from the package's feedback dimensions (each "Not reviewed"
// until rated), and notes. The overall verdict saves at once; notes save when the field
// loses focus. Aspects and notes are stored with an overall verdict, so they wait for one.
const props = defineProps({
  // `overall`: the overall choice only (the phone's bottom sheet); `details`: aspects and notes.
  part: { default: 'all', type: String },
  screen: { required: true, type: Object },
});

const session = useReviewSession();
const ids = useId();

const verdict = computed(() => session.verdictFor(props.screen.id));
const dimensions = computed(() => session.state.content?.dimensions ?? []);
const disabled = computed(() => !session.canRespond());
const held = computed(() => session.isHeld(`verdict:${props.screen.id}`));
const showOverall = computed(() => props.part !== 'details');
const showDetails = computed(() => props.part !== 'overall');
const subject = computed(() => (props.screen.kind === 'prototype' ? 'this flow' : 'this screen'));

function setOverall(value) {
  session.setOverall(props.screen.id, value);
}

function setAspect(key, value) {
  session.setAspect(props.screen.id, key, value);
}

function setNote(field, event) {
  session.setNote(props.screen.id, field, event.target.value);
}

function commit() {
  session.commitNotes(props.screen.id);
}
</script>

<template>
  <div class="rq-verdict rq-stack">
    <fieldset v-if="showOverall" class="rq-verdict__overall" :disabled="disabled">
      <legend class="rq-eyebrow" :class="{ 'visually-hidden': part === 'overall' }">Overall, {{ subject }}</legend>
      <div class="rq-seg rq-seg--block rq-seg--verdict">
        <label v-for="option in VERDICT_OPTIONS" :key="option.value" class="rq-seg__option" :class="`rq-seg__option--${option.value}`">
          <input
            type="radio"
            :name="`${ids}-overall`"
            :value="option.value"
            :checked="verdict.overall === option.value"
            @change="setOverall(option.value)"
          />
          <span>{{ part === 'overall' ? option.short : option.label }}</span>
        </label>
      </div>
      <p class="rq-xs mb-0 rq-verdict__state">
        <template v-if="verdict.overall">
          <button v-if="!disabled" class="rq-text-action" type="button" @click="setOverall(null)">Clear verdict</button>
        </template>
        <span v-else class="rq-chip rq-chip--outline">{{ NOT_REVIEWED }}</span>
      </p>
    </fieldset>

    <template v-if="showDetails">
      <fieldset class="rq-stack rq-stack--sm rq-verdict__aspects" :disabled="disabled">
        <legend class="rq-eyebrow">By aspect <span class="rq-verdict__optional">· optional</span></legend>
        <div v-for="dimension in dimensions" :key="dimension.key" class="rq-dim" role="radiogroup" :aria-labelledby="`${ids}-dim-${dimension.key}`">
          <div class="rq-dim__label">
            <span :id="`${ids}-dim-${dimension.key}`">{{ dimension.label }}<span class="visually-hidden">: {{ aspectLabel(verdict.dimensions[dimension.key]) }}</span></span>
            <span v-if="!verdict.dimensions[dimension.key]" class="rq-chip rq-chip--outline rq-dim__state" aria-hidden="true">{{ NOT_REVIEWED }}</span>
            <button
              v-else-if="!disabled"
              class="rq-text-action rq-dim__clear"
              type="button"
              :aria-label="`Clear ${dimension.label}`"
              @click="setAspect(dimension.key, null)"
            >Clear</button>
          </div>
          <div class="rq-seg rq-seg--sm rq-seg--block" :class="{ 'rq-seg--unset': !verdict.dimensions[dimension.key] }">
            <label v-for="option in ASPECT_OPTIONS" :key="option.value" class="rq-seg__option" :class="`rq-seg__option--${option.value}`">
              <input
                type="radio"
                :name="`${ids}-dim-${dimension.key}`"
                :value="option.value"
                :checked="verdict.dimensions[dimension.key] === option.value"
                @change="setAspect(dimension.key, option.value)"
              />
              <span>{{ option.label }}</span>
            </label>
          </div>
        </div>
      </fieldset>

      <div class="rq-verdict__notes rq-stack rq-stack--sm">
        <div class="rq-field">
          <label :for="`${ids}-stay`" class="rq-eyebrow">What should stay?</label>
          <textarea :id="`${ids}-stay`" class="rq-textarea" :disabled="disabled" maxlength="4000" rows="2" :value="verdict.stay" @blur="commit" @input="setNote('stay', $event)"></textarea>
        </div>
        <div class="rq-field">
          <label :for="`${ids}-change`" class="rq-eyebrow">What should change?</label>
          <textarea :id="`${ids}-change`" class="rq-textarea" :disabled="disabled" maxlength="4000" rows="2" :value="verdict.change" @blur="commit" @input="setNote('change', $event)"></textarea>
        </div>
        <div class="rq-field">
          <label :for="`${ids}-mixed`" class="rq-eyebrow">Mixed feelings? Explain</label>
          <textarea
            :id="`${ids}-mixed`"
            class="rq-textarea"
            :disabled="disabled"
            maxlength="4000"
            placeholder="Optional. For example, “I like the layout but not the wording.”"
            rows="2"
            :value="verdict.mixed"
            @blur="commit"
            @input="setNote('mixed', $event)"
          ></textarea>
        </div>
        <p v-if="held" class="rq-xs rq-verdict__held mb-0" role="status">Choose an overall verdict to save these aspects and notes. They stay here until you do.</p>
      </div>
    </template>
  </div>
</template>
