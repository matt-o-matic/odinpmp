<script setup>
import { reactive, watch } from 'vue';

import RequirementsDialog from './RequirementsDialog.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { stanceLabel } from '../../lib/requirements/requirements-topics.js';

// Accepting a proposed preference (decision rights only). The person edits the stance and
// statement, and the accepted preference is recorded in their name (Q-14). Shared by the
// Decide stage and a round's proposed preferences.
const props = defineProps({
  // Where focus starts: the statement (to edit it) or the Accept button (to confirm as proposed).
  focus: { default: 'statement', type: String },
  // A proposal from GET /tracks/:track/preferences: { key, statement, stance, dimension, sources, summaryId }.
  item: { default: null, type: Object },
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  track: { required: true, type: String },
});

const emit = defineEmits(['accepted', 'close']);

const uid = Math.random().toString(36).slice(2, 10);
const statementId = `rq-accept-statement-${uid}`;
const form = reactive({ error: '', saving: false, stance: 'keep', statement: '' });

watch(
  () => [props.open, props.item],
  ([open]) => {
    if (!open) return;
    Object.assign(form, { error: '', saving: false, stance: props.item?.stance ?? 'undecided', statement: props.item?.statement ?? '' });
  },
  { immediate: true },
);

function close() {
  if (!form.saving) emit('close');
}

async function submit() {
  if (form.saving || !props.item) return;
  if (!form.statement.trim()) {
    form.error = 'Write the preference you are accepting.';
    return;
  }
  form.saving = true;
  form.error = '';
  try {
    const result = await apiClient.acceptRequirementsPreference(props.projectId, {
      dimension: props.item.dimension || 'general',
      key: props.item.key,
      sourceSummaryId: props.item.summaryId ?? '',
      sources: props.item.sources ?? [],
      stance: form.stance,
      statement: form.statement.trim(),
      track: props.track,
    }, authSession.state.token);
    form.saving = false;
    emit('accepted', result?.decision ?? null);
  } catch (caught) {
    form.error = describeRequirementsError(caught, 'Unable to accept the preference.').message;
    form.saving = false;
  }
}
</script>

<template>
  <RequirementsDialog :busy="form.saving" :open="open" title="Accept preference" @close="close" @submit="submit">
    <fieldset class="rq-field">
      <legend>Stance</legend>
      <div class="rq-seg rq-seg--block">
        <label v-for="stance in ['keep', 'change', 'undecided']" :key="stance" class="rq-seg__option">
          <input v-model="form.stance" type="radio" :name="`rq-accept-stance-${uid}`" :value="stance" />
          <span>{{ stanceLabel(stance) }}</span>
        </label>
      </div>
    </fieldset>
    <div class="rq-field">
      <label :for="statementId">Preference</label>
      <textarea :id="statementId" v-model="form.statement" class="form-control" :data-autofocus="focus === 'statement' ? '' : undefined" maxlength="10000" rows="3"></textarea>
      <p class="rq-field__hint">Edit it as needed. Once accepted, it is recorded as yours.</p>
    </div>
    <p v-if="item?.dimension" class="rq-xs rq-muted mb-0">Dimension: {{ item.dimension }}</p>
    <p v-if="form.error" class="error-banner mb-0" role="alert">{{ form.error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="form.saving" @click="close">Cancel</button>
      <button class="primary-button" type="submit" :data-autofocus="focus === 'submit' ? '' : undefined" :disabled="form.saving">{{ form.saving ? 'Accepting…' : 'Accept preference' }}</button>
    </template>
  </RequirementsDialog>
</template>
