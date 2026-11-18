<script setup>
import { computed } from 'vue';

import './workflows.css';
import { ITEM_TYPE_LABELS, normalizeWorkflowModel } from '../../lib/workflows/workflow-model.js';
import {
  PRIORITY_OPTIONS,
  TICKET_CATEGORY_OPTIONS,
  composeItemDescription,
} from '../../lib/workflows/workflow-templates.js';
import WorkflowStatePreview from './WorkflowStatePreview.vue';

// Read-only view of a template's payload, shown before anyone chooses to edit it.
const props = defineProps({
  customFields: { default: () => [], type: Array },
  template: { required: true, type: Object },
  templates: { default: () => [], type: Array },
  workflows: { default: () => [], type: Array },
});

const payload = computed(() => props.template.payload ?? {});
const workflowModel = computed(() => normalizeWorkflowModel(payload.value));

function bindingName(binding) {
  const source = binding.sourceKind === 'workflow_template'
    ? props.templates.find((template) => template.id === binding.sourceId)
    : props.workflows.find((workflow) => workflow.id === binding.sourceId);
  const kind = binding.sourceKind === 'workflow_template' ? 'template' : 'workflow';
  return source ? `${source.name} (${kind})` : `Missing ${kind}`;
}

function fieldName(fieldId) {
  return props.customFields.find((field) => field.id === fieldId)?.name ?? 'Missing field';
}

const priorityLabel = computed(() => PRIORITY_OPTIONS.find((option) => option.value === payload.value.priority)?.label ?? 'Unchanged');
const categoryLabel = computed(() => TICKET_CATEGORY_OPTIONS.find((option) => option.value === payload.value.category)?.label ?? 'Unchanged');
</script>

<template>
  <div class="wf-stack" data-testid="template-summary">
    <template v-if="template.kind === 'workflow'">
      <dl class="wf-dl">
        <dt>Item types</dt>
        <dd>{{ (payload.itemTypes ?? []).map((type) => ITEM_TYPE_LABELS[type] ?? type).join(', ') || 'None' }}</dd>
        <dt>Size</dt>
        <dd>{{ workflowModel.states.length }} states · {{ workflowModel.transitions.length }} transitions</dd>
      </dl>
      <WorkflowStatePreview :model="workflowModel" />
    </template>

    <template v-else-if="template.kind === 'project'">
      <section class="wf-section" aria-labelledby="pts-bindings">
        <h2 id="pts-bindings">Workflow bindings</h2>
        <ul v-if="payload.workflowBindings?.length" class="wf-list">
          <li v-for="binding in payload.workflowBindings" :key="binding.itemType"><strong>{{ ITEM_TYPE_LABELS[binding.itemType] }}</strong>: {{ bindingName(binding) }}</li>
        </ul>
        <p v-else class="wf-muted">None. Tickets use the default lifecycle.</p>
      </section>
      <section class="wf-section" aria-labelledby="pts-outline">
        <h2 id="pts-outline">Starter outline</h2>
        <ul v-if="payload.outline?.epics?.length" class="pts-tree">
          <li v-for="(epic, epicIndex) in payload.outline.epics" :key="`epic-${epicIndex}`">
            <i class="bi bi-collection" aria-hidden="true"></i> {{ epic.name }}<span v-if="epic.points != null" class="wf-muted"> · {{ epic.points }} pts</span>
            <ul v-if="epic.stories?.length">
              <li v-for="(story, storyIndex) in epic.stories" :key="`story-${storyIndex}`">
                <i class="bi bi-journal-text" aria-hidden="true"></i> {{ story.name }}<span v-if="story.points != null" class="wf-muted"> · {{ story.points }} pts</span>
                <ul v-if="story.tasks?.length">
                  <li v-for="(task, taskIndex) in story.tasks" :key="`task-${taskIndex}`"><i class="bi bi-check2-square" aria-hidden="true"></i> {{ task.name }}<span v-if="task.points != null" class="wf-muted"> · {{ task.points }} pts</span></li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
        <p v-else class="wf-muted">None.</p>
      </section>
      <section class="wf-section" aria-labelledby="pts-fields">
        <h2 id="pts-fields">Custom fields</h2>
        <ul v-if="payload.customFields?.length" class="wf-list">
          <li v-for="field in payload.customFields" :key="`${field.scope}:${field.name}`">{{ field.name }} <span class="wf-muted">({{ ITEM_TYPE_LABELS[field.scope] }}, {{ field.fieldType }}{{ field.required ? ', required' : '' }})</span></li>
        </ul>
        <p v-else class="wf-muted">None.</p>
      </section>
    </template>

    <template v-else>
      <dl class="wf-dl">
        <dt>Item type</dt>
        <dd>{{ ITEM_TYPE_LABELS[payload.itemType] ?? payload.itemType }}</dd>
        <dt>Points</dt>
        <dd>{{ payload.points ?? 'Unchanged' }}</dd>
        <dt>Priority</dt>
        <dd>{{ priorityLabel }}</dd>
        <template v-if="payload.itemType === 'ticket'">
          <dt>Category</dt>
          <dd>{{ categoryLabel }}</dd>
          <dt>Severity</dt>
          <dd>{{ payload.severity ?? 'Unchanged' }}</dd>
        </template>
        <dt>Custom fields</dt>
        <dd>
          <span v-if="!payload.customFieldDefaults?.length">None</span>
          <span v-for="entry in payload.customFieldDefaults ?? []" :key="entry.fieldId" class="d-block">{{ fieldName(entry.fieldId) }}: {{ entry.value }}</span>
        </dd>
      </dl>
      <section class="wf-section" aria-labelledby="wis-description">
        <h2 id="wis-description">Description</h2>
        <p class="wis-text">{{ composeItemDescription(payload.description, payload.acceptanceCriteria) || 'No description.' }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.pts-tree, .pts-tree ul { display: grid; gap: 0.25rem; margin: 0; padding-left: 1.25rem; list-style: none; }
.pts-tree { padding-left: 0; }
.wis-text { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 120ch; }
</style>
