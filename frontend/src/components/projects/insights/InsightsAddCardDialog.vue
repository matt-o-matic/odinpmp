<script setup>
import { computed, ref, watch } from 'vue';

import RequirementsDialog from '../../requirements/RequirementsDialog.vue';
import { cardKey } from '../../../lib/insights/insights-layout.js';

// Edit mode's "Add card": pick one built-in card or saved report to append to the dashboard.

const props = defineProps({
  addable: { required: true, type: Object },
  open: { default: false, type: Boolean },
});

const emit = defineEmits(['add', 'close']);

const selected = ref('');
const options = computed(() => [...props.addable.builtIn, ...props.addable.reports]);
const hasOptions = computed(() => options.value.length > 0);

watch(() => props.open, (open) => {
  if (open) selected.value = options.value[0] ? cardKey(options.value[0].card) : '';
});

function submit() {
  const option = options.value.find((entry) => cardKey(entry.card) === selected.value);
  if (option) emit('add', option.card);
}
</script>

<template>
  <RequirementsDialog class="insights-dialog" :open="open" title="Add a card" @close="emit('close')" @submit="submit">
    <p v-if="!hasOptions" class="rq-small mb-0">Every card is already on this dashboard, and there are no other saved reports to add.</p>
    <template v-else>
      <fieldset v-if="addable.builtIn.length" class="insights-dialog__group">
        <legend>Insights cards</legend>
        <label v-for="option in addable.builtIn" :key="cardKey(option.card)" class="insights-dialog__option">
          <input v-model="selected" class="form-check-input" type="radio" name="insights-add-card" :value="cardKey(option.card)" />
          <span>
            <strong>{{ option.title }}</strong>
            <small v-if="option.description">{{ option.description }}</small>
          </span>
        </label>
      </fieldset>
      <fieldset v-if="addable.reports.length" class="insights-dialog__group">
        <legend>Saved reports (they run on their own)</legend>
        <label v-for="option in addable.reports" :key="cardKey(option.card)" class="insights-dialog__option">
          <input v-model="selected" class="form-check-input" type="radio" name="insights-add-card" :value="cardKey(option.card)" />
          <span>
            <strong>{{ option.title }}</strong>
            <small v-if="option.description">{{ option.description }}</small>
          </span>
        </label>
      </fieldset>
    </template>
    <template #footer>
      <button class="ghost-button" type="button" @click="emit('close')">Cancel</button>
      <button class="primary-button" type="submit" :disabled="!hasOptions || !selected">Add card</button>
    </template>
  </RequirementsDialog>
</template>
