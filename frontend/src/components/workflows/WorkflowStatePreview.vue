<script setup>
import { computed } from 'vue';

import './workflows.css';
import { previewColumns } from '../../lib/workflows/workflow-model.js';

// Read-only picture of the state machine: states grouped by category in board order, each
// with the transitions that leave it and their rules.
const props = defineProps({
  headingLevel: { default: 2, type: Number },
  model: { required: true, type: Object },
});

const columns = computed(() => previewColumns(props.model));
const headingTag = computed(() => `h${props.headingLevel}`);
const subheadingTag = computed(() => `h${Math.min(props.headingLevel + 1, 6)}`);

function rules(transition) {
  const parts = [];
  if (transition.allowedRoles.length) parts.push(transition.allowedRoles.join(', '));
  if (transition.approvalRequired) parts.push('approval');
  if (transition.requiredFields.length) parts.push(`needs ${transition.requiredFields.join(', ')}`);
  return parts.join(' · ');
}
</script>

<template>
  <section class="wf-section wf-preview" aria-labelledby="wf-preview-title" data-testid="workflow-preview">
    <component :is="headingTag" id="wf-preview-title">State machine</component>
    <p v-if="!columns.length" class="wf-muted">Add states to see the workflow.</p>
    <div v-else class="wf-preview__columns">
      <div v-for="column in columns" :key="column.value" class="wf-preview__column" :class="`wf-preview__column--${column.value}`">
        <component :is="subheadingTag" class="wf-preview__category">{{ column.label }}</component>
        <ul class="wf-list">
          <li v-for="state in column.states" :key="state.uid" class="wf-preview__state">
            <div class="wf-preview__name">
              <strong>{{ state.label || state.key || 'Untitled state' }}</strong>
              <span class="wf-preview__key">{{ state.key }}</span>
            </div>
            <div class="wf-preview__badges">
              <span v-if="state.initial" class="wf-badge"><i class="bi bi-play-circle" aria-hidden="true"></i> Initial</span>
              <span v-if="state.terminal" class="wf-badge"><i class="bi bi-stop-circle" aria-hidden="true"></i> Terminal</span>
              <span v-if="state.slaHours > 0" class="wf-badge"><i class="bi bi-clock" aria-hidden="true"></i> SLA {{ state.slaHours }}h</span>
              <span v-if="state.requiredFields.length" class="wf-badge">Needs {{ state.requiredFields.join(', ') }}</span>
            </div>
            <ul v-if="state.outgoing.length" class="wf-preview__moves" :aria-label="`Moves from ${state.label || state.key}`">
              <li v-for="transition in state.outgoing" :key="transition.uid">
                <i class="bi bi-arrow-right" aria-hidden="true"></i><span class="visually-hidden">to</span>
                {{ transition.toLabel }}
                <span v-if="rules(transition)" class="wf-muted">({{ rules(transition) }})</span>
              </li>
            </ul>
            <p v-else class="wf-hint">No outgoing moves.</p>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.wf-preview__columns { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
.wf-preview__column { display: grid; gap: 0.5rem; align-content: start; padding: 0.5rem; border-radius: 0.5rem; border-top: 0.25rem solid var(--bs-border-color); background: var(--bs-tertiary-bg); }
.wf-preview__column--active { border-top-color: var(--bs-primary); }
.wf-preview__column--done { border-top-color: var(--bs-success); }
.wf-preview__column--cancelled { border-top-color: var(--bs-secondary); }
.wf-preview__category { font-size: 0.75rem !important; text-transform: uppercase; letter-spacing: 0.04em; }
.wf-preview__state { display: grid; gap: 0.35rem; padding: 0.5rem; border: 1px solid var(--bs-border-color); border-radius: 0.375rem; background: var(--bs-body-bg); }
.wf-preview__name { display: grid; gap: 0.125rem; overflow-wrap: anywhere; }
.wf-preview__key { font-family: var(--bs-font-monospace); font-size: 0.75rem; color: var(--bs-secondary-color); }
.wf-preview__badges { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.wf-preview__moves { display: grid; gap: 0.125rem; margin: 0; padding: 0; list-style: none; font-size: 0.8125rem; overflow-wrap: anywhere; }
</style>
