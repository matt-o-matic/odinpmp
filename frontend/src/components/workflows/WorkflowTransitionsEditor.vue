<script setup>
import './workflows.css';
import {
  WORKFLOW_ROLES,
  createTransition,
  moveEntry,
  parseFieldList,
} from '../../lib/workflows/workflow-model.js';

// Edits `model.transitions` in place. From/to pickers only offer states defined above, and a
// transition's role and approval rules sit behind a disclosure so the list stays scannable.
const props = defineProps({
  errors: { default: () => [], type: Array },
  model: { required: true, type: Object },
});

function rowErrors(transition) {
  return props.errors.filter((entry) => entry.target === `transition:${transition.uid}`);
}

function stateLabel(key) {
  return props.model.states.find((state) => state.key === key)?.label || key || 'unset';
}

function rulesSummary(transition) {
  const parts = [transition.allowedRoles.length ? `Roles: ${transition.allowedRoles.join(', ')}` : 'Any editor'];
  if (transition.approvalRequired) parts.push(transition.approverRoles.length ? `Approval by ${transition.approverRoles.join(', ')}` : 'Approval required');
  if (transition.requiredFields.length) parts.push(`Requires ${transition.requiredFields.join(', ')}`);
  return parts.join(' · ');
}

function toggleRole(list, role, checked) {
  const next = new Set(list);
  if (checked) next.add(role); else next.delete(role);
  return WORKFLOW_ROLES.filter((entry) => next.has(entry));
}

function addTransition() {
  props.model.transitions.push(createTransition(props.model));
}

function move(index, delta) {
  props.model.transitions = moveEntry(props.model.transitions, index, delta);
}

function remove(transition) {
  props.model.transitions = props.model.transitions.filter((entry) => entry.uid !== transition.uid);
}
</script>

<template>
  <section class="wf-section" aria-labelledby="wf-transitions-title">
    <div class="wf-section__head">
      <div>
        <h2 id="wf-transitions-title">Transitions</h2>
        <p class="wf-hint">Items can only move along these transitions. Leave roles empty to allow anyone who can edit the plan.</p>
      </div>
      <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="!model.states.length" @click="addTransition"><i class="bi bi-plus-lg" aria-hidden="true"></i> Add transition</button>
    </div>
    <p v-if="!model.transitions.length" class="wf-muted">No transitions. Items stay in their initial state until you add one.</p>
    <ol class="wf-list" aria-label="Workflow transitions">
      <li v-for="(transition, index) in model.transitions" :key="transition.uid" class="wf-row" :class="{ 'wf-row--invalid': rowErrors(transition).length }" data-testid="workflow-transition-row">
        <div class="wf-row__head">
          <span class="wf-row__title">{{ stateLabel(transition.fromState) }} <i class="bi bi-arrow-right" aria-hidden="true"></i><span class="visually-hidden">to</span> {{ stateLabel(transition.toState) }}</span>
          <div class="wf-row__tools">
            <button class="wf-icon-button" type="button" :aria-label="`Move transition ${transition.key || index + 1} up`" :disabled="index === 0" @click="move(index, -1)"><i class="bi bi-arrow-up" aria-hidden="true"></i></button>
            <button class="wf-icon-button" type="button" :aria-label="`Move transition ${transition.key || index + 1} down`" :disabled="index === model.transitions.length - 1" @click="move(index, 1)"><i class="bi bi-arrow-down" aria-hidden="true"></i></button>
            <button class="wf-icon-button wf-icon-button--danger" type="button" :aria-label="`Remove transition ${transition.key || index + 1}`" @click="remove(transition)"><i class="bi bi-trash3" aria-hidden="true"></i></button>
          </div>
        </div>
        <div class="wf-grid">
          <div class="wf-field">
            <label :for="`${transition.uid}-from`">From state</label>
            <select :id="`${transition.uid}-from`" v-model="transition.fromState" class="form-select">
              <option value="" disabled>Choose a state</option>
              <option v-for="state in model.states" :key="state.uid" :value="state.key">{{ state.label || state.key }}</option>
            </select>
          </div>
          <div class="wf-field">
            <label :for="`${transition.uid}-to`">To state</label>
            <select :id="`${transition.uid}-to`" v-model="transition.toState" class="form-select">
              <option value="" disabled>Choose a state</option>
              <option v-for="state in model.states" :key="state.uid" :value="state.key">{{ state.label || state.key }}</option>
            </select>
          </div>
          <div class="wf-field">
            <label :for="`${transition.uid}-key`">Transition key</label>
            <input :id="`${transition.uid}-key`" v-model="transition.key" class="form-control" maxlength="120" spellcheck="false" />
          </div>
        </div>
        <details class="wf-rules">
          <summary><span class="wf-label">Rules</span> <span class="wf-muted">{{ rulesSummary(transition) }}</span></summary>
          <div class="wf-stack wf-rules__body">
            <fieldset class="wf-field">
              <legend>Roles allowed to move items</legend>
              <div class="wf-checks">
                <label v-for="role in WORKFLOW_ROLES" :key="role" class="wf-check">
                  <input type="checkbox" :checked="transition.allowedRoles.includes(role)" @change="transition.allowedRoles = toggleRole(transition.allowedRoles, role, $event.target.checked)" /> {{ role }}
                </label>
              </div>
            </fieldset>
            <label class="wf-check"><input v-model="transition.approvalRequired" type="checkbox" /> Requires approval before the move</label>
            <fieldset v-if="transition.approvalRequired" class="wf-field">
              <legend>Approver roles</legend>
              <div class="wf-checks">
                <label v-for="role in WORKFLOW_ROLES" :key="role" class="wf-check">
                  <input type="checkbox" :checked="transition.approverRoles.includes(role)" @change="transition.approverRoles = toggleRole(transition.approverRoles, role, $event.target.checked)" /> {{ role }}
                </label>
              </div>
            </fieldset>
            <div class="wf-field">
              <label :for="`${transition.uid}-required`">Fields required for this move</label>
              <input :id="`${transition.uid}-required`" class="form-control" :value="transition.requiredFields.join(', ')" @change="transition.requiredFields = parseFieldList($event.target.value)" />
              <span class="wf-hint">Comma separated item or custom field names.</span>
            </div>
          </div>
        </details>
        <p v-for="entry in rowErrors(transition)" :key="entry.message" class="wf-error"><i class="bi bi-exclamation-circle" aria-hidden="true"></i> {{ entry.message }}</p>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.wf-rules summary { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; min-height: 2.75rem; cursor: pointer; }
.wf-rules__body { padding: 0.5rem 0 0; }
</style>
