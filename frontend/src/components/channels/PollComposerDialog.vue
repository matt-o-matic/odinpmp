<script setup>
import { computed, ref, useId, watch } from 'vue';

import {
  POLL_KINDS,
  POLL_OPTIONS_MAX,
  POLL_OPTIONS_MIN,
  POLL_PRESETS,
  kindHint,
  moveEntry,
  newPollDraft,
  pollPayload,
  takesOptions,
  withOption,
  withoutOption,
  withPreset,
} from '../../lib/channels/polls.js';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';

// The composer's Poll dialog (docs/engagements/plan.md, Polls): the question, the kind, the
// options (2 to 20, in order), and how votes show. Create hands the poll to the conversation,
// which posts it with whatever is in the message box above it.
const props = defineProps({
  busy: { default: false, type: Boolean },
  error: { default: '', type: String },
  open: { default: false, type: Boolean },
});
const emit = defineEmits(['close', 'submit']);

const uid = useId();
const draft = ref(newPollDraft());
const localError = ref('');
const shownError = computed(() => localError.value || props.error);
const optionsShown = computed(() => takesOptions(draft.value.kind));

watch(() => props.open, (open) => {
  if (open) {
    draft.value = newPollDraft();
    localError.value = '';
  }
});

function addOption() {
  draft.value = withOption(draft.value);
}

function removeOption(key) {
  draft.value = withoutOption(draft.value, key);
}

function moveOption(index, step) {
  draft.value = { ...draft.value, options: moveEntry(draft.value.options, index, step) };
}

function useYesNoMaybe() {
  draft.value = withPreset(draft.value, POLL_PRESETS.yesNoMaybe);
}

function submit() {
  const result = pollPayload(draft.value);
  localError.value = result.error ?? '';
  if (result.poll) emit('submit', result.poll);
}
</script>

<template>
  <RequirementsDialog class="poll-composer" :busy="busy" :open="open" title="New poll" @close="emit('close')" @submit="submit">
    <div class="rq-field">
      <label :for="`${uid}-question`">Question</label>
      <input :id="`${uid}-question`" v-model="draft.question" class="form-control" maxlength="300" autocomplete="off" data-autofocus />
    </div>

    <fieldset class="rq-field">
      <legend class="rq-field__label">Kind</legend>
      <div class="poll-composer__kinds">
        <label v-for="kind in POLL_KINDS" :key="kind.id" class="poll-composer__kind">
          <input v-model="draft.kind" type="radio" :name="`${uid}-kind`" :value="kind.id" />
          <span>{{ kind.label }}</span>
        </label>
      </div>
      <p class="rq-field__hint mb-0">{{ kindHint(draft.kind) }}</p>
    </fieldset>

    <fieldset v-if="optionsShown" class="rq-field">
      <legend class="rq-field__label">Options</legend>
      <ol class="poll-composer__options">
        <li v-for="(option, index) in draft.options" :key="option.key" class="poll-composer__option">
          <label class="visually-hidden" :for="`${uid}-${option.key}`">Option {{ index + 1 }}</label>
          <input :id="`${uid}-${option.key}`" v-model="option.label" class="form-control" maxlength="200" autocomplete="off" :placeholder="`Option ${index + 1}`" />
          <button class="poll-composer__icon" type="button" :aria-label="`Move option ${index + 1} up`" :disabled="index === 0" @click="moveOption(index, -1)">
            <i class="bi bi-arrow-up" aria-hidden="true"></i>
          </button>
          <button class="poll-composer__icon" type="button" :aria-label="`Move option ${index + 1} down`" :disabled="index === draft.options.length - 1" @click="moveOption(index, 1)">
            <i class="bi bi-arrow-down" aria-hidden="true"></i>
          </button>
          <button class="poll-composer__icon" type="button" :aria-label="`Remove option ${index + 1}`" :disabled="draft.options.length <= POLL_OPTIONS_MIN" @click="removeOption(option.key)">
            <i class="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </li>
      </ol>
      <div class="poll-composer__row">
        <button class="ghost-button ghost-button--compact" type="button" :disabled="draft.options.length >= POLL_OPTIONS_MAX" @click="addOption">
          <i class="bi bi-plus-lg" aria-hidden="true"></i> Add option
        </button>
        <button v-if="draft.kind === 'single'" class="ghost-button ghost-button--compact" type="button" @click="useYesNoMaybe">Yes / No / Maybe</button>
      </div>
    </fieldset>

    <div v-if="draft.kind === 'multiple'" class="rq-field">
      <label :for="`${uid}-max`">Most choices each person can pick</label>
      <input :id="`${uid}-max`" v-model="draft.maxChoices" class="form-control poll-composer__narrow" type="number" min="1" :max="draft.options.length" inputmode="numeric" placeholder="Any" />
    </div>

    <fieldset v-if="draft.kind === 'rating'" class="rq-field">
      <legend class="rq-field__label">Scale</legend>
      <div class="poll-composer__kinds">
        <label class="poll-composer__kind"><input v-model.number="draft.scaleMax" type="radio" :name="`${uid}-scale`" :value="5" /><span>1 to 5</span></label>
        <label class="poll-composer__kind"><input v-model.number="draft.scaleMax" type="radio" :name="`${uid}-scale`" :value="10" /><span>1 to 10</span></label>
      </div>
    </fieldset>

    <fieldset class="rq-field">
      <legend class="rq-field__label">Votes and results</legend>
      <label class="poll-composer__check"><input v-model="draft.anonymous" type="checkbox" /> <span>Anonymous: nobody sees who voted</span></label>
      <label class="poll-composer__check"><input v-model="draft.showResults" type="checkbox" true-value="after_vote" false-value="always" /> <span>Show results only after someone votes</span></label>
    </fieldset>

    <div class="rq-field">
      <label :for="`${uid}-closes`">Closes (optional)</label>
      <input :id="`${uid}-closes`" v-model="draft.closesAt" class="form-control poll-composer__narrow" type="datetime-local" />
    </div>

    <p v-if="shownError" class="error-banner mb-0" role="alert">{{ shownError }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Posting…' : 'Post poll' }}</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.poll-composer { width: min(36rem, calc(100vw - 2rem)); }
.poll-composer__kinds { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.poll-composer__kind { display: inline-flex; align-items: center; gap: 0.4rem; min-height: 2.75rem; padding: 0 0.75rem; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--surface); cursor: pointer; }
.poll-composer__kind:has(input:checked) { border-color: var(--accent); background: var(--accent-soft, var(--surface-soft)); }
.poll-composer__kind:focus-within { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.poll-composer__options { display: grid; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }
.poll-composer__option { display: grid; grid-template-columns: minmax(0, 1fr) repeat(3, 2.75rem); gap: 0.25rem; align-items: center; }
.poll-composer__icon { display: inline-flex; align-items: center; justify-content: center; width: 2.75rem; height: 2.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface); color: var(--ink); }
.poll-composer__icon:disabled { opacity: 0.4; }
.poll-composer__icon:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.poll-composer__row { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.poll-composer__row .ghost-button { min-height: 2.75rem; }
.poll-composer__check { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; }
.poll-composer__check input { width: 1.15rem; height: 1.15rem; }
.poll-composer__narrow { max-width: 16rem; }
</style>
