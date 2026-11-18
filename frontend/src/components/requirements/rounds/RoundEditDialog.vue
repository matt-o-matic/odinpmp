<script setup>
import { computed, nextTick, ref, watch } from 'vue';

import RoundReviewerPicker from './RoundReviewerPicker.vue';
import RequirementsDialog from '../RequirementsDialog.vue';
import { apiClient, authSession } from '../../../lib/auth/index.js';
import { describeRequirementsError } from '../../../lib/requirements/requirements-errors.js';
import {
  REMINDER_OPTIONS,
  describePublishError,
  reviewerKindLabel,
  roundPatch,
  toDateTimeInputValue,
} from '../../../lib/requirements/requirements-rounds.js';

// Change an open round: required flags, removing and adding reviewers, the due date, the
// reminder, and the note (members and up). Added reviewers get an invitation right away.
const props = defineProps({
  candidates: { default: () => [], type: Array },
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  roles: { default: () => new Map(), type: Map },
  // The round detail: { id, number, dueAt, reminder, note, reviewers }.
  round: { default: null, type: Object },
});

const emit = defineEmits(['close', 'saved']);

const form = ref({ added: [], due: '', note: '', reminder: '', reviewers: [] });
const errors = ref({});
const error = ref('');
const saving = ref(false);

const activeKeys = computed(() => (props.round?.reviewers ?? []).filter((reviewer) => !reviewer.removedAt).map((reviewer) => `${reviewer.actorType}:${reviewer.actorId}`));

watch(
  () => props.open,
  (open) => {
    if (!open || !props.round) return;
    form.value = {
      added: [],
      due: toDateTimeInputValue(props.round.dueAt),
      note: props.round.note ?? '',
      reminder: props.round.reminder?.daysBefore ? String(props.round.reminder.daysBefore) : '',
      reviewers: (props.round.reviewers ?? []).filter((reviewer) => !reviewer.removedAt).map((reviewer) => ({
        id: reviewer.id,
        kind: reviewerKindLabel({ actorType: reviewer.actorType, role: props.roles.get(reviewer.actorId) }),
        name: reviewer.name,
        remove: false,
        required: Boolean(reviewer.required),
        submitted: Boolean(reviewer.submittedAt),
      })),
    };
    errors.value = {};
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
  const { errors: problems, payload } = roundPatch({ form: form.value, original: props.round });
  errors.value = problems;
  error.value = '';
  if (Object.keys(problems).length > 0) {
    // The due date's message sits at the top of a long dialog, out of view on a tablet.
    await nextTick();
    document.querySelector('.rq-dialog[open] .rq-field__error')?.scrollIntoView?.({ block: 'center' });
    return;
  }
  if (!payload) {
    emit('close');
    return;
  }
  saving.value = true;
  try {
    const result = await apiClient.updateRequirementsRound(props.projectId, props.round.id, payload, authSession.state.token);
    saving.value = false;
    emit('saved', result);
  } catch (caught) {
    saving.value = false;
    error.value = describePublishError(caught, { candidates: props.candidates })?.message
      ?? describeRequirementsError(caught, 'Unable to save the changes. Try again.').message;
  }
}
</script>

<template>
  <RequirementsDialog :busy="saving" focus-title :open="open" :title="round ? `Edit round ${round.number}` : 'Edit round'" @close="close" @submit="submit">
    <div class="rq-dialog-body">
      <div class="rq-field-row">
        <div class="rq-field">
          <label for="rq-edit-due">Due</label>
          <input id="rq-edit-due" v-model="form.due" class="form-control" type="datetime-local" :aria-invalid="errors.due ? 'true' : undefined" :aria-describedby="errors.due ? 'rq-edit-due-error' : undefined" />
          <p v-if="errors.due" id="rq-edit-due-error" class="rq-field__hint rq-field__error" role="alert">{{ errors.due }}</p>
        </div>
        <div class="rq-field">
          <label for="rq-edit-reminder">Reminder</label>
          <select id="rq-edit-reminder" v-model="form.reminder" class="form-select" :aria-invalid="errors.reminder ? 'true' : undefined" :aria-describedby="errors.reminder ? 'rq-edit-reminder-error' : undefined">
            <option v-for="option in REMINDER_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <p v-if="errors.reminder" id="rq-edit-reminder-error" class="rq-field__hint rq-field__error" role="alert">{{ errors.reminder }}</p>
        </div>
      </div>

      <div class="rq-field">
        <label for="rq-edit-note">Note to reviewers</label>
        <textarea id="rq-edit-note" v-model="form.note" class="form-control" maxlength="4000" rows="2"></textarea>
        <p class="rq-field__hint">Changing the note doesn’t send another email.</p>
      </div>

      <fieldset class="rq-field">
        <legend>Current reviewers</legend>
        <ul class="rq-candidates">
          <li v-for="reviewer in form.reviewers" :key="reviewer.id" class="rq-candidate" :class="{ 'rq-candidate--off': reviewer.remove }">
            <span class="rq-candidate__name" :class="{ 'rq-muted': reviewer.remove }">
              {{ reviewer.name }} <span class="rq-xs rq-muted">· {{ reviewer.kind }}<template v-if="reviewer.submitted"> · submitted</template></span>
            </span>
            <label class="rq-candidate__required">
              <input v-model="reviewer.required" type="checkbox" :disabled="reviewer.remove" :aria-label="`${reviewer.name} is required`" />
              <span aria-hidden="true">required</span>
            </label>
            <button
              class="ghost-button ghost-button--compact"
              type="button"
              :aria-label="`${reviewer.remove ? 'Keep' : 'Remove'} ${reviewer.name}`"
              :aria-pressed="reviewer.remove ? 'true' : 'false'"
              @click="reviewer.remove = !reviewer.remove"
            >{{ reviewer.remove ? 'Keep' : 'Remove' }}</button>
          </li>
        </ul>
        <p v-if="errors.reviewers" class="rq-field__hint rq-field__error" role="alert">{{ errors.reviewers }}</p>
        <p class="rq-field__hint">Removing someone takes the round out of their inbox. Feedback they already gave stays.</p>
      </fieldset>

      <fieldset class="rq-field">
        <legend>Add reviewers</legend>
        <RoundReviewerPicker v-model="form.added" :candidates="candidates" :exclude="activeKeys" name="edit-add" />
        <p class="rq-field__hint">People you add get an invitation when you save.</p>
      </fieldset>
    </div>

    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="saving" @click="close">Cancel</button>
      <button class="primary-button" type="submit" :disabled="saving">{{ saving ? 'Saving…' : 'Save changes' }}</button>
    </template>
  </RequirementsDialog>
</template>
