<script setup>
import { reactive, watch } from 'vue';

import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import { buildGovernancePayload, createGovernanceForm } from '../../lib/memory/agent-memory.js';

// Admin-only retention controls for one memory: expiry, legal hold, retention policy.
const props = defineProps({
  busy: { default: false, type: Boolean },
  error: { default: '', type: String },
  memory: { default: null, type: Object },
  open: { default: false, type: Boolean },
});

const emit = defineEmits(['close', 'submit']);

const form = reactive(createGovernanceForm(null));

watch(
  () => props.open,
  (open) => {
    if (open) Object.assign(form, createGovernanceForm(props.memory));
  },
  { immediate: true },
);

function submit() {
  if (props.memory) emit('submit', buildGovernancePayload(props.memory, form));
}
</script>

<template>
  <RequirementsDialog :busy="busy" :open="open" title="Retention" @close="emit('close')" @submit="submit">
    <p v-if="memory" class="rq-field__hint mb-0">For “{{ memory.title }}”.</p>
    <div class="form-check memory-hold">
      <input id="memory-governance-hold" v-model="form.legalHold" class="form-check-input" type="checkbox" aria-describedby="memory-governance-hold-hint" />
      <label class="form-check-label" for="memory-governance-hold">Legal hold</label>
      <p id="memory-governance-hold-hint" class="rq-field__hint">While held, nobody can correct or forget it, and expiry doesn’t remove it.</p>
    </div>
    <div class="rq-field">
      <label for="memory-governance-expiry">Expires on</label>
      <input id="memory-governance-expiry" v-model="form.expiresOn" class="form-control" type="date" aria-describedby="memory-governance-expiry-hint" />
      <p id="memory-governance-expiry-hint" class="rq-field__hint">Leave empty to keep it until someone forgets it. After this date the AI stops using it, and “Purge expired” removes it.</p>
    </div>
    <div class="rq-field">
      <label for="memory-governance-policy">Retention policy reference</label>
      <input id="memory-governance-policy" v-model="form.retentionPolicyId" class="form-control" maxlength="128" placeholder="Optional, for example legal-case-42" />
    </div>
    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Saving…' : 'Save retention' }}</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.memory-hold {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.5rem;
  align-items: center;
  min-height: 2.75rem;
  margin: 0;
  padding-left: 0;
}

.memory-hold .form-check-input {
  width: 1.25rem;
  height: 1.25rem;
  margin: 0;
}

.memory-hold .form-check-label {
  font-size: 0.875rem;
  font-weight: 700;
}

.memory-hold .rq-field__hint {
  grid-column: 2;
}
</style>
