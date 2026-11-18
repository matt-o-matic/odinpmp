<script setup>
import { ref, watch } from 'vue';

import RoundCloseFields from './RoundCloseFields.vue';
import RequirementsDialog from '../RequirementsDialog.vue';
import { apiClient, authSession } from '../../../lib/auth/index.js';
import { describeRequirementsError, requirementsErrorCode } from '../../../lib/requirements/requirements-errors.js';
import { closeFormError, closePayload } from '../../../lib/requirements/requirements-rounds.js';

// Close round N (decision rights): an outcome, the chosen direction when there is
// one, and an optional statement. The API records a round decision owned by the closer.
const props = defineProps({
  directions: { default: () => [], type: Array },
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  round: { default: null, type: Object },
});

const emit = defineEmits(['close', 'closed', 'stale']);

const form = ref({ directionId: '', outcome: '', statement: '' });
const error = ref('');
const saving = ref(false);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.value = { directionId: '', outcome: '', statement: '' };
    error.value = '';
    saving.value = false;
  },
  { immediate: true },
);

function close() {
  if (!saving.value) emit('close');
}

async function submit() {
  if (saving.value || !props.round) return;
  const problem = closeFormError(form.value);
  if (problem) {
    error.value = problem;
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const result = await apiClient.closeRequirementsRound(props.projectId, props.round.id, closePayload(form.value), authSession.state.token);
    saving.value = false;
    emit('closed', result);
  } catch (caught) {
    saving.value = false;
    error.value = requirementsErrorCode(caught) === 'round_not_open'
      ? 'This round was already closed. The page shows its current state.'
      : describeRequirementsError(caught, 'Unable to close the round. Try again.').message;
    if (requirementsErrorCode(caught) === 'round_not_open') emit('stale');
  }
}
</script>

<template>
  <RequirementsDialog :busy="saving" :open="open" :title="round ? `Close round ${round.number}` : 'Close round'" @close="close" @submit="submit">
    <RoundCloseFields v-model="form" :directions="directions" :error="error" id-prefix="rq-close-dialog" :round-number="round?.number ?? null" />
    <template #footer>
      <button class="ghost-button" type="button" :disabled="saving" @click="close">Cancel</button>
      <button class="primary-button" type="submit" :disabled="saving">{{ saving ? 'Closing…' : `Close round ${round?.number ?? ''}`.trim() }}</button>
    </template>
  </RequirementsDialog>
</template>
