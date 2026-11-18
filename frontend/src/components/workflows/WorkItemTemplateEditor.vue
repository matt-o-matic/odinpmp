<script setup>
import { computed } from 'vue';

import './workflows.css';
import { ITEM_TYPE_LABELS, WORK_ITEM_TYPES } from '../../lib/workflows/workflow-model.js';
import { PRIORITY_OPTIONS, TICKET_CATEGORY_OPTIONS, TICKET_SEVERITY_OPTIONS } from '../../lib/workflows/workflow-templates.js';

// Payload editor for work-item templates: the text, estimate and fields a new epic, story,
// task or ticket starts with. Edits `draft` in place; the parent validates and saves.
const props = defineProps({
  customFields: { default: () => [], type: Array },
  draft: { required: true, type: Object },
});

const scopedFields = computed(() => props.customFields.filter((field) => field.status === 'active' && field.scope === props.draft.itemType));

function fieldFor(entry) {
  return props.customFields.find((field) => field.id === entry.fieldId) ?? null;
}

function changeItemType(value) {
  props.draft.itemType = value;
  props.draft.customFieldDefaults = props.draft.customFieldDefaults.filter((entry) => fieldFor(entry)?.scope === value);
  if (value !== 'ticket') { props.draft.category = ''; props.draft.severity = ''; }
}

function addDefault() {
  const used = new Set(props.draft.customFieldDefaults.map((entry) => entry.fieldId));
  const field = scopedFields.value.find((candidate) => !used.has(candidate.id));
  props.draft.customFieldDefaults.push({ fieldId: field?.id ?? '', value: field?.fieldType === 'boolean' ? 'true' : '' });
}
</script>

<template>
  <div class="wf-stack">
    <section class="wf-section" aria-labelledby="wi-fields-title">
      <h2 id="wi-fields-title">Item defaults</h2>
      <div class="wf-grid">
        <div class="wf-field">
          <label for="wi-item-type">Item type</label>
          <select id="wi-item-type" class="form-select" :value="draft.itemType" @change="changeItemType($event.target.value)">
            <option v-for="type in WORK_ITEM_TYPES" :key="type" :value="type">{{ ITEM_TYPE_LABELS[type] }}</option>
          </select>
        </div>
        <div class="wf-field">
          <label for="wi-points">Points</label>
          <input id="wi-points" v-model="draft.points" class="form-control" type="number" min="0" max="999" step="1" />
        </div>
        <div class="wf-field">
          <label for="wi-priority">Priority</label>
          <select id="wi-priority" v-model="draft.priority" class="form-select">
            <option value="">Leave as is</option>
            <option v-for="option in PRIORITY_OPTIONS" :key="option.value" :value="String(option.value)">{{ option.label }}</option>
          </select>
        </div>
        <template v-if="draft.itemType === 'ticket'">
          <div class="wf-field">
            <label for="wi-category">Ticket category</label>
            <select id="wi-category" v-model="draft.category" class="form-select">
              <option value="">Leave as is</option>
              <option v-for="option in TICKET_CATEGORY_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </div>
          <div class="wf-field">
            <label for="wi-severity">Severity</label>
            <select id="wi-severity" v-model="draft.severity" class="form-select">
              <option value="">Leave as is</option>
              <option v-for="option in TICKET_SEVERITY_OPTIONS" :key="option" :value="option">{{ option }}</option>
            </select>
          </div>
        </template>
      </div>
      <div class="wf-field">
        <label for="wi-description">Description</label>
        <textarea id="wi-description" v-model="draft.description" class="form-control" rows="4" maxlength="5000"></textarea>
      </div>
      <div class="wf-field">
        <label for="wi-criteria">Acceptance criteria</label>
        <textarea id="wi-criteria" v-model="draft.acceptanceCriteria" class="form-control" rows="4" maxlength="4000" aria-describedby="wi-criteria-hint"></textarea>
        <span id="wi-criteria-hint" class="wf-hint">Added to the description under an "Acceptance criteria" heading.</span>
      </div>
    </section>

    <section class="wf-section" aria-labelledby="wi-custom-title">
      <div class="wf-section__head">
        <div>
          <h2 id="wi-custom-title">Custom field defaults</h2>
          <p class="wf-hint">Saved on the item when it is created from this template.</p>
        </div>
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="!scopedFields.length" @click="addDefault"><i class="bi bi-plus-lg" aria-hidden="true"></i> Add default</button>
      </div>
      <p v-if="!scopedFields.length" class="wf-muted">No active {{ ITEM_TYPE_LABELS[draft.itemType].toLowerCase() }} custom fields exist.</p>
      <ul class="wf-list">
        <li v-for="(entry, index) in draft.customFieldDefaults" :key="index" class="wf-row">
          <div class="wf-grid">
            <div class="wf-field">
              <label :for="`wi-default-field-${index}`">Custom field</label>
              <select :id="`wi-default-field-${index}`" v-model="entry.fieldId" class="form-select">
                <option value="" disabled>Choose a field</option>
                <option v-for="field in scopedFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </div>
            <div class="wf-field">
              <label :for="`wi-default-value-${index}`">Default value</label>
              <select v-if="fieldFor(entry)?.fieldType === 'boolean'" :id="`wi-default-value-${index}`" v-model="entry.value" class="form-select">
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
              <select v-else-if="fieldFor(entry)?.fieldType === 'enum'" :id="`wi-default-value-${index}`" v-model="entry.value" class="form-select">
                <option value="" disabled>Choose an option</option>
                <option v-for="option in fieldFor(entry).options" :key="option" :value="option">{{ option }}</option>
              </select>
              <input v-else :id="`wi-default-value-${index}`" v-model="entry.value" class="form-control" :type="fieldFor(entry)?.fieldType === 'number' ? 'number' : fieldFor(entry)?.fieldType === 'date' ? 'date' : 'text'" />
            </div>
          </div>
          <div class="wf-row__tools">
            <button class="btn btn-sm btn-outline-danger" type="button" @click="draft.customFieldDefaults.splice(index, 1)"><i class="bi bi-trash3" aria-hidden="true"></i> Remove default</button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
