<script setup>
import { computed } from 'vue';

import './workflows.css';
import { ITEM_TYPE_LABELS, WORKFLOW_ITEM_TYPES } from '../../lib/workflows/workflow-model.js';
import WorkflowStatePreview from './WorkflowStatePreview.vue';
import WorkflowStatesEditor from './WorkflowStatesEditor.vue';
import WorkflowTransitionsEditor from './WorkflowTransitionsEditor.vue';

// The states-and-transitions part of a workflow, shared by the definition editor and the
// workflow template editor. `validation` comes from validateWorkflowModel in the parent,
// which owns the save action.
const props = defineProps({
  model: { required: true, type: Object },
  showMessages: { default: true, type: Boolean },
  validation: { required: true, type: Object },
});

const itemTypeErrors = computed(() => props.validation.errors.filter((entry) => entry.target === 'itemTypes'));

function toggleItemType(type, checked) {
  const next = new Set(props.model.itemTypes);
  if (checked) next.add(type); else next.delete(type);
  props.model.itemTypes = WORKFLOW_ITEM_TYPES.filter((entry) => next.has(entry));
}
</script>

<template>
  <div class="wf-editor-layout">
    <div class="wf-stack">
      <fieldset class="wf-section" aria-describedby="wf-item-types-hint">
        <legend class="wf-label">Item types</legend>
        <p id="wf-item-types-hint" class="wf-hint">The kinds of work this workflow can govern once a project binds it.</p>
        <div class="wf-checks">
          <label v-for="type in WORKFLOW_ITEM_TYPES" :key="type" class="wf-check">
            <input type="checkbox" :checked="model.itemTypes.includes(type)" @change="toggleItemType(type, $event.target.checked)" /> {{ ITEM_TYPE_LABELS[type] }}
          </label>
        </div>
        <p v-for="entry in itemTypeErrors" :key="entry.message" class="wf-error"><i class="bi bi-exclamation-circle" aria-hidden="true"></i> {{ entry.message }}</p>
      </fieldset>
      <WorkflowStatesEditor :errors="validation.errors" :model="model" />
      <WorkflowTransitionsEditor :errors="validation.errors" :model="model" />
    </div>
    <div class="wf-stack wf-editor-layout__aside">
      <div v-if="showMessages" aria-live="polite" class="wf-stack" data-testid="workflow-validation">
        <ul v-if="validation.errors.length" class="wf-messages wf-messages--errors" aria-label="Problems to fix before saving">
          <li v-for="entry in validation.errors" :key="`${entry.target}:${entry.message}`"><i class="bi bi-x-circle" aria-hidden="true"></i> {{ entry.message }}</li>
        </ul>
        <p v-else class="wf-messages wf-messages--ok"><i class="bi bi-check-circle" aria-hidden="true"></i> The workflow is valid.</p>
        <ul v-if="validation.warnings.length" class="wf-messages wf-messages--warnings" aria-label="Warnings">
          <li v-for="entry in validation.warnings" :key="`${entry.target}:${entry.message}`"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> {{ entry.message }}</li>
        </ul>
      </div>
      <WorkflowStatePreview :model="model" />
    </div>
  </div>
</template>
