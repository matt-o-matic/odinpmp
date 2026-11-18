<script setup>
import { computed, reactive, ref, watch } from 'vue';

import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import { apiClient } from '../../lib/auth/index.js';
import { billingErrorMessage } from '../../lib/projects/project-billing.js';

// The SOW milestone a story bills to (invoice-gen E-05), in the plan editor. It saves on its own
// through its dialog, apart from the editor's Save, because the mapping is billing data. Only
// project and workspace admins and managers see it; it hides when the project has no SOW.

const props = defineProps({
  projectId: { required: true, type: String },
  storyId: { required: true, type: String },
  token: { default: '', type: String },
});

const state = ref(null);
const editing = reactive({ busy: false, error: '', milestoneId: '', open: false });
const fieldId = `story-milestone-${Math.random().toString(36).slice(2, 10)}`;

async function load() {
  if (!props.token || !props.projectId) return;
  try {
    state.value = await apiClient.passive.getStoryMilestones(props.projectId, props.token);
  } catch {
    state.value = null;
  }
}
watch(() => props.projectId, load, { immediate: true });

const milestones = computed(() => state.value?.milestones ?? []);
const story = computed(() => (state.value?.stories ?? []).find((entry) => entry.id === props.storyId) ?? null);
const current = computed(() => milestones.value.find((milestone) => milestone.id === story.value?.milestoneId) ?? null);
const visible = computed(() => Boolean(state.value?.agreement) && milestones.value.length > 0 && Boolean(story.value));

function open() {
  Object.assign(editing, { busy: false, error: '', milestoneId: current.value ? String(current.value.id) : 'none', open: true });
}

async function save() {
  if (editing.busy) return;
  editing.busy = true;
  editing.error = '';
  try {
    state.value = await apiClient.updateStoryMilestones(props.projectId, [{ milestoneId: editing.milestoneId === 'none' ? null : Number(editing.milestoneId), storyId: props.storyId }], props.token);
    editing.open = false;
  } catch (error) {
    editing.error = billingErrorMessage(error, 'The milestone could not be saved.');
  } finally {
    editing.busy = false;
  }
}
</script>

<template>
  <div v-if="visible" class="field-group story-milestone" data-testid="story-milestone-field">
    <span :id="fieldId" class="story-milestone__label">SOW milestone</span>
    <div class="story-milestone__value">
      <span>{{ current?.name ?? 'None (No SOW)' }}</span>
      <button class="ghost-button ghost-button--compact" type="button" aria-label="Change SOW milestone" @click="open">
        <i class="bi bi-pencil" aria-hidden="true"></i> Change
      </button>
    </div>
    <RequirementsDialog :busy="editing.busy" :open="editing.open" title="SOW milestone" @close="editing.open = false" @submit="save">
      <div class="rq-field">
        <label :for="`${fieldId}-select`">Milestone this story bills to</label>
        <select :id="`${fieldId}-select`" v-model="editing.milestoneId" class="form-select">
          <option v-for="milestone in milestones" :key="milestone.id" :value="String(milestone.id)">{{ milestone.name }}</option>
          <option value="none">None (No SOW)</option>
        </select>
        <p class="rq-field__hint">Time on this story and its tasks bills to this milestone.</p>
      </div>
      <p v-if="editing.error" class="error-banner mb-0" role="alert">{{ editing.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="editing.busy" @click="editing.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="editing.busy">{{ editing.busy ? 'Saving…' : 'Save milestone' }}</button>
      </template>
    </RequirementsDialog>
  </div>
</template>

<style scoped>
.story-milestone__label {
  display: block;
  font-weight: 600;
}

.story-milestone__value {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
}
</style>
