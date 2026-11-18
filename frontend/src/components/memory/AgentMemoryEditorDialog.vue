<script setup>
import { computed, reactive, ref, watch } from 'vue';

import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import {
  MEMORY_SENSITIVITIES,
  MEMORY_TYPES,
  PERSONAL_SCOPE,
  buildCorrectionPayload,
  buildNewMemoryPayload,
  createMemoryForm,
  validateMemoryForm,
} from '../../lib/memory/agent-memory.js';

// Adds a memory, or corrects one in place (mode 'correct' needs `memory`).
const props = defineProps({
  busy: { default: false, type: Boolean },
  defaultProject: { default: '', type: String },
  error: { default: '', type: String },
  memory: { default: null, type: Object },
  mode: { default: 'add', type: String },
  open: { default: false, type: Boolean },
  projects: { default: () => [], type: Array },
});

const emit = defineEmits(['close', 'submit']);

const form = reactive(createMemoryForm());
const errors = ref({});
const nothingChanged = ref(false);
const isCorrection = computed(() => props.mode === 'correct');
const title = computed(() => (isCorrection.value ? 'Correct memory' : 'Add memory'));
const sensitivityHint = computed(() => MEMORY_SENSITIVITIES.find((option) => option.value === form.sensitivity)?.hint ?? '');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const defaultProject = props.projects.some((project) => project.id === props.defaultProject) ? props.defaultProject : '';
    Object.assign(form, createMemoryForm(isCorrection.value ? props.memory : null, { project: defaultProject }));
    errors.value = {};
    nothingChanged.value = false;
  },
  { immediate: true },
);

function submit() {
  errors.value = validateMemoryForm(form);
  if (Object.keys(errors.value).length) return;
  if (!isCorrection.value) {
    emit('submit', buildNewMemoryPayload(form));
    return;
  }
  const payload = buildCorrectionPayload(props.memory, form);
  nothingChanged.value = !payload;
  if (payload) emit('submit', payload);
}
</script>

<template>
  <RequirementsDialog :busy="busy" :open="open" :title="title" @close="emit('close')" @submit="submit">
    <p class="rq-field__hint mb-0">
      <template v-if="isCorrection">The AI uses the corrected wording from now on. The change is recorded with your name.</template>
      <template v-else>Teach the AI a decision, preference, or fact it should keep in mind when it works for you.</template>
    </p>
    <div class="rq-field">
      <label for="memory-editor-title">Title</label>
      <input
        id="memory-editor-title"
        v-model="form.title"
        class="form-control"
        maxlength="255"
        @input="errors.title = ''"
        :aria-invalid="Boolean(errors.title)"
        :aria-describedby="errors.title ? 'memory-editor-title-error' : undefined"
        data-autofocus
      />
      <p v-if="errors.title" id="memory-editor-title-error" class="memory-field-error">{{ errors.title }}</p>
    </div>
    <div class="rq-field">
      <label for="memory-editor-content">What the AI should remember</label>
      <textarea
        id="memory-editor-content"
        v-model="form.content"
        class="form-control"
        rows="5"
        @input="errors.content = ''"
        :aria-invalid="Boolean(errors.content)"
        :aria-describedby="errors.content ? 'memory-editor-content-error' : undefined"
      ></textarea>
      <p v-if="errors.content" id="memory-editor-content-error" class="memory-field-error">{{ errors.content }}</p>
    </div>
    <div class="memory-editor-grid">
      <div class="rq-field">
        <label for="memory-editor-type">Type</label>
        <select id="memory-editor-type" v-model="form.memoryType" class="form-select">
          <option v-for="option in MEMORY_TYPES" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </div>
      <div class="rq-field">
        <label for="memory-editor-sensitivity">Who can see it</label>
        <select id="memory-editor-sensitivity" v-model="form.sensitivity" class="form-select" aria-describedby="memory-editor-sensitivity-hint">
          <option v-for="option in MEMORY_SENSITIVITIES" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <p id="memory-editor-sensitivity-hint" class="rq-field__hint">{{ sensitivityHint }}</p>
      </div>
    </div>
    <div v-if="isCorrection" class="rq-field">
      <label for="memory-editor-confidence">Confidence (%)</label>
      <input
        id="memory-editor-confidence"
        v-model.number="form.confidence"
        class="form-control memory-editor-confidence"
        type="number"
        inputmode="numeric"
        min="0"
        max="100"
        step="1"
        @input="errors.confidence = ''"
        :aria-invalid="Boolean(errors.confidence)"
        :aria-describedby="errors.confidence ? 'memory-editor-confidence-hint memory-editor-confidence-error' : 'memory-editor-confidence-hint'"
      />
      <p id="memory-editor-confidence-hint" class="rq-field__hint">How far the AI should rely on this, from 0 to 100. 100 means certain.</p>
      <p v-if="errors.confidence" id="memory-editor-confidence-error" class="memory-field-error">{{ errors.confidence }}</p>
    </div>
    <div v-if="!isCorrection" class="rq-field">
      <label for="memory-editor-project">Applies to</label>
      <select id="memory-editor-project" v-model="form.project" class="form-select" aria-describedby="memory-editor-project-hint">
        <option :value="PERSONAL_SCOPE">Just me (personal)</option>
        <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
      </select>
      <p id="memory-editor-project-hint" class="rq-field__hint">Project memory is shared with everyone on the project. You can add it to projects you can edit.</p>
    </div>
    <p v-if="nothingChanged" class="rq-field__hint mb-0" role="status">Nothing has changed yet.</p>
    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Saving…' : isCorrection ? 'Save correction' : 'Add memory' }}</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.memory-editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}

.memory-editor-confidence {
  max-width: 8rem;
}

.memory-field-error {
  margin: 0;
  color: var(--bs-danger-text-emphasis, #b42318);
  font-size: 0.78rem;
}

html.dark .memory-field-error {
  color: #ff9d97;
}

@media (max-width: 36rem) {
  .memory-editor-grid {
    grid-template-columns: 1fr;
  }
}
</style>
