<script setup>
import { computed } from 'vue';

import './rounds.css';
import { availableOutcomes, defaultCloseStatement } from '../../../lib/requirements/requirements-rounds.js';

// The fields for closing a round: how it ends, the direction when one was chosen, and an
// optional statement. Used by the Close round dialog and by "Close round N first" while
// publishing. The closer owns the recorded decision.
const props = defineProps({
  // [{ directionId, title }]
  directions: { default: () => [], type: Array },
  error: { default: '', type: String },
  idPrefix: { default: 'rq-close', type: String },
  // { outcome, directionId, statement }
  modelValue: { required: true, type: Object },
  roundNumber: { default: null, type: Number },
});

const emit = defineEmits(['update:modelValue']);

const outcomes = computed(() => availableOutcomes(props.directions));
const directionTitle = computed(() => props.directions.find((direction) => direction.directionId === props.modelValue.directionId)?.title ?? '');
const placeholder = computed(() => (props.modelValue.outcome
  ? defaultCloseStatement({ directionTitle: directionTitle.value, number: props.roundNumber ?? '?', outcome: props.modelValue.outcome })
  : ''));

function update(field, value) {
  emit('update:modelValue', { ...props.modelValue, [field]: value });
}
</script>

<template>
  <div class="rq-stack">
    <fieldset class="rq-field">
      <legend>How does round {{ roundNumber }} end?</legend>
      <div class="rq-stack rq-stack--sm">
        <label v-for="outcome in outcomes" :key="outcome.key" class="rq-candidate__pick rq-outcome">
          <input
            type="radio"
            :name="`${idPrefix}-outcome`"
            :value="outcome.key"
            :checked="modelValue.outcome === outcome.key"
            :aria-describedby="`${idPrefix}-${outcome.key}-help`"
            @change="update('outcome', outcome.key)"
          />
          <span>
            <strong class="rq-small">{{ outcome.label }}</strong>
            <span :id="`${idPrefix}-${outcome.key}-help`" class="rq-xs rq-muted d-block">{{ outcome.help }}</span>
          </span>
        </label>
      </div>
    </fieldset>
    <div v-if="modelValue.outcome === 'direction-chosen'" class="rq-field">
      <label :for="`${idPrefix}-direction`">Direction</label>
      <select :id="`${idPrefix}-direction`" class="form-select" :value="modelValue.directionId" @change="update('directionId', $event.target.value)">
        <option value="">Choose a direction</option>
        <option v-for="direction in directions" :key="direction.directionId" :value="direction.directionId">{{ direction.title }}</option>
      </select>
    </div>
    <div class="rq-field">
      <label :for="`${idPrefix}-statement`">Statement <span class="rq-muted">(optional)</span></label>
      <textarea
        :id="`${idPrefix}-statement`"
        class="form-control"
        maxlength="10000"
        rows="3"
        :placeholder="placeholder"
        :value="modelValue.statement"
        @input="update('statement', $event.target.value)"
      ></textarea>
      <p class="rq-field__hint">Closing records a decision in your name. Without a statement it reads as shown.</p>
    </div>
    <p class="rq-xs rq-muted mb-0">
      <i class="bi bi-info-circle" aria-hidden="true"></i>
      The round’s questions close with it: each undecided one is recorded with Odin’s proposed answer, or deferred when there is none. The round’s preferences are settled with this decision.
    </p>
    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
  </div>
</template>
