<script setup>
import { ref, watch } from 'vue';

import './rounds.css';
import RequirementsDialog from '../RequirementsDialog.vue';
import { apiClient, authSession } from '../../../lib/auth/index.js';
import { describeRequirementsError } from '../../../lib/requirements/requirements-errors.js';
import { reviewerStatus } from '../../../lib/requirements/requirements-rounds.js';

// Remind reviewers who haven't submitted: each one chosen gets a fresh invitation email
// (stakeholders get a new link; earlier links keep working).
const props = defineProps({
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  // Active reviewers who haven't submitted.
  reviewers: { default: () => [], type: Array },
  roundId: { default: '', type: String },
  roundNumber: { default: null, type: Number },
});

const emit = defineEmits(['close', 'done']);

const chosen = ref([]);
const sending = ref(false);
const error = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    chosen.value = props.reviewers.map((reviewer) => reviewer.id);
    sending.value = false;
    error.value = '';
  },
  { immediate: true },
);

function close() {
  if (!sending.value) emit('close');
}

async function submit() {
  if (sending.value) return;
  if (chosen.value.length === 0) {
    error.value = 'Choose at least one reviewer to remind.';
    return;
  }
  sending.value = true;
  error.value = '';
  const sent = [];
  const failed = [];
  let latest = null;
  for (const reviewer of props.reviewers.filter((entry) => chosen.value.includes(entry.id))) {
    try {
      latest = await apiClient.resendRequirementsRoundInvitation(props.projectId, props.roundId, reviewer.id, authSession.state.token);
      sent.push(reviewer.name);
    } catch (caught) {
      failed.push({ message: describeRequirementsError(caught, 'Not sent.').message, name: reviewer.name });
    }
  }
  sending.value = false;
  if (failed.length > 0) {
    error.value = failed.map((entry) => `${entry.name}: ${entry.message}`).join(' ');
    if (sent.length > 0) emit('done', { latest, partial: true, sent });
    return;
  }
  emit('done', { latest, partial: false, sent });
}
</script>

<template>
  <RequirementsDialog :busy="sending" :open="open" :title="`Remind reviewers of round ${roundNumber ?? ''}`.trim()" @close="close" @submit="submit">
    <fieldset class="rq-field">
      <legend>Who should get a reminder?</legend>
      <ul class="rq-candidates">
        <li v-for="reviewer in reviewers" :key="reviewer.id" class="rq-candidate">
          <label class="rq-candidate__pick">
            <input v-model="chosen" type="checkbox" :value="reviewer.id" />
            <span class="rq-candidate__name">{{ reviewer.name }} <span class="rq-xs rq-muted">· {{ reviewerStatus(reviewer).label }}</span></span>
          </label>
        </li>
      </ul>
      <p class="rq-field__hint">Each person gets the invitation again. External reviewers get a new link; their earlier link keeps working.</p>
    </fieldset>
    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="sending" @click="close">Cancel</button>
      <button class="primary-button" type="submit" :disabled="sending">{{ sending ? 'Sending…' : 'Send reminders' }}</button>
    </template>
  </RequirementsDialog>
</template>
