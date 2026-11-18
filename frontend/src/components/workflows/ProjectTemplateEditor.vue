<script setup>
import './workflows.css';
import { ITEM_TYPE_LABELS, WORKFLOW_ITEM_TYPES } from '../../lib/workflows/workflow-model.js';
import { createOutlineNode } from '../../lib/workflows/workflow-templates.js';

// Payload editor for project templates: which workflow governs each item type, a starter
// outline (epics, stories, tasks) and the custom fields new projects should have.
// Edits `draft` in place; the parent validates and saves.
const props = defineProps({
  draft: { required: true, type: Object },
  workflowTemplates: { default: () => [], type: Array },
  workflows: { default: () => [], type: Array },
});

const FIELD_TYPES = [
  { label: 'Text', value: 'string' },
  { label: 'Number', value: 'number' },
  { label: 'Date', value: 'date' },
  { label: 'Yes / no', value: 'boolean' },
  { label: 'Choice', value: 'enum' },
];

function templatesFor(itemType) {
  return props.workflowTemplates.filter((template) => template.payload?.itemTypes?.includes(itemType));
}

function definitionsFor(itemType) {
  return props.workflows.filter((workflow) => workflow.status === 'active' && workflow.itemTypes.includes(itemType));
}

function addBinding() {
  const used = new Set(props.draft.workflowBindings.map((binding) => binding.itemType));
  const itemType = WORKFLOW_ITEM_TYPES.find((type) => !used.has(type)) ?? 'story';
  props.draft.workflowBindings.push({ itemType, source: '' });
}

function removeAt(list, index) {
  list.splice(index, 1);
}

function addField() {
  props.draft.customFields.push({ description: '', fieldType: 'string', name: '', optionsText: '', required: false, scope: 'story' });
}

function updatePoints(node, value) {
  node.points = value === '' ? null : value;
}
</script>

<template>
  <div class="wf-stack">
    <section class="wf-section" aria-labelledby="pt-bindings-title">
      <div class="wf-section__head">
        <div>
          <h2 id="pt-bindings-title">Workflow bindings</h2>
          <p class="wf-hint">A workflow template becomes a definition the first time a project uses it. Tickets keep the default lifecycle unless you bind them here.</p>
        </div>
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="draft.workflowBindings.length >= WORKFLOW_ITEM_TYPES.length" @click="addBinding"><i class="bi bi-plus-lg" aria-hidden="true"></i> Add binding</button>
      </div>
      <p v-if="!draft.workflowBindings.length" class="wf-muted">No bindings. New projects use unbound statuses and the default ticket lifecycle.</p>
      <ul class="wf-list">
        <li v-for="(binding, index) in draft.workflowBindings" :key="index" class="wf-row">
          <div class="wf-grid">
            <div class="wf-field">
              <label :for="`pt-binding-type-${index}`">Item type</label>
              <select :id="`pt-binding-type-${index}`" v-model="binding.itemType" class="form-select" @change="binding.source = ''">
                <option v-for="type in WORKFLOW_ITEM_TYPES" :key="type" :value="type">{{ ITEM_TYPE_LABELS[type] }}</option>
              </select>
            </div>
            <div class="wf-field">
              <label :for="`pt-binding-source-${index}`">Workflow</label>
              <select :id="`pt-binding-source-${index}`" v-model="binding.source" class="form-select">
                <option value="" disabled>Choose a workflow</option>
                <optgroup v-if="templatesFor(binding.itemType).length" label="Workflow templates">
                  <option v-for="template in templatesFor(binding.itemType)" :key="template.id" :value="`workflow_template:${template.id}`">{{ template.name }}</option>
                </optgroup>
                <optgroup v-if="definitionsFor(binding.itemType).length" label="Existing workflows">
                  <option v-for="workflow in definitionsFor(binding.itemType)" :key="workflow.id" :value="`workflow_definition:${workflow.id}`">{{ workflow.name }}</option>
                </optgroup>
              </select>
            </div>
          </div>
          <div class="wf-row__tools">
            <button class="btn btn-sm btn-outline-danger" type="button" @click="removeAt(draft.workflowBindings, index)"><i class="bi bi-trash3" aria-hidden="true"></i> Remove binding</button>
          </div>
        </li>
      </ul>
    </section>

    <section class="wf-section" aria-labelledby="pt-outline-title">
      <div class="wf-section__head">
        <div>
          <h2 id="pt-outline-title">Starter outline</h2>
          <p class="wf-hint">Epics, stories and tasks created with each new project. Items start in their workflow's initial state.</p>
        </div>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="draft.epics.push(createOutlineNode('epic'))"><i class="bi bi-plus-lg" aria-hidden="true"></i> Add epic</button>
      </div>
      <p v-if="!draft.epics.length" class="wf-muted">No outline. New projects start empty.</p>
      <ol class="wf-list pt-outline">
        <li v-for="(epic, epicIndex) in draft.epics" :key="`epic-${epicIndex}`" class="wf-row" data-testid="template-outline-epic">
          <div class="pt-node">
            <div class="wf-field pt-node__name">
              <label :for="`pt-epic-${epicIndex}`">Epic name</label>
              <input :id="`pt-epic-${epicIndex}`" v-model="epic.name" class="form-control" maxlength="200" />
            </div>
            <div class="wf-field pt-node__points">
              <label :for="`pt-epic-points-${epicIndex}`">Points</label>
              <input :id="`pt-epic-points-${epicIndex}`" class="form-control" type="number" min="0" max="999" :value="epic.points ?? ''" @input="updatePoints(epic, $event.target.value)" />
            </div>
            <button class="wf-icon-button wf-icon-button--danger pt-node__remove" type="button" :aria-label="`Remove epic ${epic.name || epicIndex + 1}`" @click="removeAt(draft.epics, epicIndex)"><i class="bi bi-trash3" aria-hidden="true"></i></button>
          </div>
          <div class="wf-field">
            <label :for="`pt-epic-desc-${epicIndex}`">Epic description</label>
            <textarea :id="`pt-epic-desc-${epicIndex}`" v-model="epic.description" class="form-control" rows="2" maxlength="5000"></textarea>
          </div>
          <ol class="wf-list pt-children" :aria-label="`Stories in ${epic.name || 'epic'}`">
            <li v-for="(story, storyIndex) in epic.stories" :key="`story-${storyIndex}`" class="pt-child">
              <div class="pt-node">
                <div class="wf-field pt-node__name">
                  <label :for="`pt-story-${epicIndex}-${storyIndex}`">Story name</label>
                  <input :id="`pt-story-${epicIndex}-${storyIndex}`" v-model="story.name" class="form-control" maxlength="200" />
                </div>
                <div class="wf-field pt-node__points">
                  <label :for="`pt-story-points-${epicIndex}-${storyIndex}`">Points</label>
                  <input :id="`pt-story-points-${epicIndex}-${storyIndex}`" class="form-control" type="number" min="0" max="999" :value="story.points ?? ''" @input="updatePoints(story, $event.target.value)" />
                </div>
                <button class="wf-icon-button wf-icon-button--danger pt-node__remove" type="button" :aria-label="`Remove story ${story.name || storyIndex + 1}`" @click="removeAt(epic.stories, storyIndex)"><i class="bi bi-trash3" aria-hidden="true"></i></button>
              </div>
              <ol class="wf-list pt-children" :aria-label="`Tasks in ${story.name || 'story'}`">
                <li v-for="(task, taskIndex) in story.tasks" :key="`task-${taskIndex}`" class="pt-child">
                  <div class="pt-node">
                    <div class="wf-field pt-node__name">
                      <label :for="`pt-task-${epicIndex}-${storyIndex}-${taskIndex}`">Task name</label>
                      <input :id="`pt-task-${epicIndex}-${storyIndex}-${taskIndex}`" v-model="task.name" class="form-control" maxlength="200" />
                    </div>
                    <div class="wf-field pt-node__points">
                      <label :for="`pt-task-points-${epicIndex}-${storyIndex}-${taskIndex}`">Points</label>
                      <input :id="`pt-task-points-${epicIndex}-${storyIndex}-${taskIndex}`" class="form-control" type="number" min="0" max="999" :value="task.points ?? ''" @input="updatePoints(task, $event.target.value)" />
                    </div>
                    <button class="wf-icon-button wf-icon-button--danger pt-node__remove" type="button" :aria-label="`Remove task ${task.name || taskIndex + 1}`" @click="removeAt(story.tasks, taskIndex)"><i class="bi bi-trash3" aria-hidden="true"></i></button>
                  </div>
                </li>
              </ol>
              <button class="btn btn-sm btn-outline-secondary pt-add" type="button" @click="story.tasks.push(createOutlineNode('task'))"><i class="bi bi-plus" aria-hidden="true"></i> Add task to {{ story.name || 'story' }}</button>
            </li>
          </ol>
          <button class="btn btn-sm btn-outline-secondary pt-add" type="button" @click="epic.stories.push(createOutlineNode('story'))"><i class="bi bi-plus" aria-hidden="true"></i> Add story to {{ epic.name || 'epic' }}</button>
        </li>
      </ol>
    </section>

    <section class="wf-section" aria-labelledby="pt-fields-title">
      <div class="wf-section__head">
        <div>
          <h2 id="pt-fields-title">Custom fields</h2>
          <p class="wf-hint">Added to the workspace when missing. A field with the same name and item type is reused.</p>
        </div>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="addField"><i class="bi bi-plus-lg" aria-hidden="true"></i> Add custom field</button>
      </div>
      <p v-if="!draft.customFields.length" class="wf-muted">No custom fields.</p>
      <ul class="wf-list">
        <li v-for="(field, index) in draft.customFields" :key="`field-${index}`" class="wf-row">
          <div class="wf-grid">
            <div class="wf-field">
              <label :for="`pt-field-name-${index}`">Field name</label>
              <input :id="`pt-field-name-${index}`" v-model="field.name" class="form-control" maxlength="160" />
            </div>
            <div class="wf-field">
              <label :for="`pt-field-scope-${index}`">Item type</label>
              <select :id="`pt-field-scope-${index}`" v-model="field.scope" class="form-select">
                <option v-for="type in WORKFLOW_ITEM_TYPES" :key="type" :value="type">{{ ITEM_TYPE_LABELS[type] }}</option>
              </select>
            </div>
            <div class="wf-field">
              <label :for="`pt-field-type-${index}`">Field type</label>
              <select :id="`pt-field-type-${index}`" v-model="field.fieldType" class="form-select">
                <option v-for="type in FIELD_TYPES" :key="type.value" :value="type.value">{{ type.label }}</option>
              </select>
            </div>
            <div v-if="field.fieldType === 'enum'" class="wf-field">
              <label :for="`pt-field-options-${index}`">Options (comma separated)</label>
              <input :id="`pt-field-options-${index}`" v-model="field.optionsText" class="form-control" />
            </div>
          </div>
          <div class="wf-section__head">
            <label class="wf-check"><input v-model="field.required" type="checkbox" /> Required before completion checks pass</label>
            <button class="btn btn-sm btn-outline-danger" type="button" @click="removeAt(draft.customFields, index)"><i class="bi bi-trash3" aria-hidden="true"></i> Remove field</button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.pt-node { display: grid; grid-template-columns: minmax(0, 1fr) 6rem auto; gap: 0.5rem; align-items: end; }
.pt-children { padding-left: 1rem; border-left: 2px solid var(--bs-border-color); }
.pt-child { display: grid; gap: 0.25rem; }
.pt-add { justify-self: start; }
@media (max-width: 36rem) {
  .pt-node { grid-template-columns: minmax(0, 1fr) 5rem; }
  .pt-node__name { grid-column: 1 / -1; }
}
</style>
