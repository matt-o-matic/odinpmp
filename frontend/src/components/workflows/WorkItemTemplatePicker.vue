<script>
import { apiClient } from '../../lib/auth/index.js';

// The plan editor mounts a picker per selected item, so instances share the list briefly.
const CACHE_MS = 60_000;
const cache = { at: 0, promise: null, token: '' };

function loadTemplates(token) {
  if (!cache.promise || cache.token !== token || Date.now() - cache.at > CACHE_MS) {
    Object.assign(cache, {
      at: Date.now(),
      promise: apiClient.listWorkflowTemplates({ kind: 'work_item', status: 'active' }, token)
        .then((result) => result.templates ?? [])
        .catch(() => { cache.promise = null; return []; }),
      token,
    });
  }
  return cache.promise;
}
</script>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';

import { usableTemplates } from '../../lib/workflows/workflow-templates.js';

// "Start from template" for item create forms. Lists the active work-item templates for the
// item type and emits the chosen template (or null) so the host form can prefill itself.
// Renders nothing when no template applies, so forms without templates look unchanged.
const props = defineProps({
  disabled: { default: false, type: Boolean },
  fieldClass: { default: 'field-group', type: String },
  inputClass: { default: '', type: String },
  inputId: { required: true, type: String },
  itemType: { required: true, type: String },
  modelValue: { default: '', type: String },
  token: { default: '', type: String },
});

const emit = defineEmits(['apply', 'update:modelValue']);
const templates = ref([]);

const options = computed(() => usableTemplates(templates.value, 'work_item', props.itemType));
const selected = computed(() => options.value.find((template) => template.id === props.modelValue) ?? null);

async function load() {
  if (!props.token) return;
  templates.value = await loadTemplates(props.token);
}

function choose(templateId) {
  emit('update:modelValue', templateId);
  emit('apply', options.value.find((template) => template.id === templateId) ?? null);
}

watch(() => props.token, load);
onMounted(load);
</script>

<template>
  <div v-if="options.length" :class="fieldClass">
    <label :for="inputId">Template</label>
    <select :id="inputId" :class="inputClass" :value="modelValue" :disabled="disabled" :aria-describedby="`${inputId}-hint`" @change="choose($event.target.value)">
      <option value="">No template</option>
      <option v-for="template in options" :key="template.id" :value="template.id">{{ template.name }}</option>
    </select>
    <small :id="`${inputId}-hint`" class="d-block text-body-secondary">{{ selected?.description || 'Fills in the description, estimate and fields from a saved template.' }}</small>
  </div>
</template>
