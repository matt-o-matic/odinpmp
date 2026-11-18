<script setup>
import './workflows.css';
import {
  STATE_CATEGORIES,
  createState,
  keyFromLabel,
  moveEntry,
  parseFieldList,
  removeState,
  renameStateKey,
} from '../../lib/workflows/workflow-model.js';

// Edits `model.states` in place, like the plan editor edits the selected item. Renaming a key
// or removing a state also updates the transitions that point at it.
const props = defineProps({
  errors: { default: () => [], type: Array },
  model: { required: true, type: Object },
});

const initialGroup = `wf-initial-${Math.random().toString(36).slice(2, 8)}`;
const previousKeys = new Map();

function rowErrors(state) {
  return props.errors.filter((entry) => entry.target === `state:${state.uid}`);
}

function addState() {
  props.model.states.push(createState(props.model));
}

function move(index, delta) {
  props.model.states = moveEntry(props.model.states, index, delta);
}

function remove(state) {
  const next = removeState(props.model, state.uid);
  props.model.states = next.states;
  props.model.transitions = next.transitions;
  if (next.states.length && !next.states.some((entry) => entry.initial)) next.states[0].initial = true;
}

function setInitial(state) {
  for (const entry of props.model.states) entry.initial = entry.uid === state.uid;
}

function rememberKey(state) {
  previousKeys.set(state.uid, state.key);
}

function commitKey(state) {
  state.key = state.key.trim();
  props.model.transitions = renameStateKey(props.model, previousKeys.get(state.uid), state.key);
  previousKeys.delete(state.uid);
}

function fillKeyFromLabel(state) {
  if (state.key.trim()) return;
  const taken = new Set(props.model.states.filter((entry) => entry.uid !== state.uid).map((entry) => entry.key));
  let key = keyFromLabel(state.label) || 'state';
  for (let index = 2; taken.has(key); index += 1) key = `${keyFromLabel(state.label) || 'state'}_${index}`;
  state.key = key;
}

function updateSla(state, value) {
  state.slaHours = value === '' ? Number.NaN : Number(value);
}
</script>

<template>
  <section class="wf-section" aria-labelledby="wf-states-title">
    <div class="wf-section__head">
      <div>
        <h2 id="wf-states-title">States</h2>
        <p class="wf-hint">Order sets how states appear on boards. Exactly one state is initial; new items start there.</p>
      </div>
      <button class="btn btn-sm btn-outline-secondary" type="button" @click="addState"><i class="bi bi-plus-lg" aria-hidden="true"></i> Add state</button>
    </div>
    <p v-if="!model.states.length" class="wf-muted">No states yet. Add the first state.</p>
    <ol class="wf-list" aria-label="Workflow states">
      <li v-for="(state, index) in model.states" :key="state.uid" class="wf-row" :class="{ 'wf-row--invalid': rowErrors(state).length }" data-testid="workflow-state-row">
        <div class="wf-row__head">
          <span class="wf-row__title">{{ index + 1 }}. {{ state.label || 'Untitled state' }}</span>
          <div class="wf-row__tools">
            <button class="wf-icon-button" type="button" :aria-label="`Move ${state.label || 'state'} up`" :disabled="index === 0" @click="move(index, -1)"><i class="bi bi-arrow-up" aria-hidden="true"></i></button>
            <button class="wf-icon-button" type="button" :aria-label="`Move ${state.label || 'state'} down`" :disabled="index === model.states.length - 1" @click="move(index, 1)"><i class="bi bi-arrow-down" aria-hidden="true"></i></button>
            <button class="wf-icon-button wf-icon-button--danger" type="button" :aria-label="`Remove ${state.label || 'state'}`" @click="remove(state)"><i class="bi bi-trash3" aria-hidden="true"></i></button>
          </div>
        </div>
        <div class="wf-grid">
          <div class="wf-field">
            <label :for="`${state.uid}-label`">State label</label>
            <input :id="`${state.uid}-label`" v-model="state.label" class="form-control" maxlength="120" @blur="fillKeyFromLabel(state)" />
          </div>
          <div class="wf-field">
            <label :for="`${state.uid}-key`">State key</label>
            <input :id="`${state.uid}-key`" v-model="state.key" class="form-control" maxlength="80" spellcheck="false" :aria-describedby="`${state.uid}-key-hint`" @focus="rememberKey(state)" @change="commitKey(state)" />
            <span :id="`${state.uid}-key-hint`" class="wf-hint">Stored as the item status.</span>
          </div>
          <div class="wf-field">
            <label :for="`${state.uid}-category`">Category</label>
            <select :id="`${state.uid}-category`" v-model="state.category" class="form-select">
              <option v-for="category in STATE_CATEGORIES" :key="category.value" :value="category.value">{{ category.label }}</option>
            </select>
          </div>
          <div class="wf-field">
            <label :for="`${state.uid}-sla`">SLA hours</label>
            <input :id="`${state.uid}-sla`" class="form-control" type="number" min="0" max="87600" step="1" :value="Number.isNaN(state.slaHours) ? '' : state.slaHours" :aria-describedby="`${state.uid}-sla-hint`" @input="updateSla(state, $event.target.value)" />
            <span :id="`${state.uid}-sla-hint`" class="wf-hint">0 means no SLA.</span>
          </div>
        </div>
        <div class="wf-checks">
          <label class="wf-check"><input type="radio" :name="initialGroup" :checked="state.initial" @change="setInitial(state)" /> Initial state</label>
          <label class="wf-check"><input v-model="state.terminal" type="checkbox" /> Terminal (items may be deleted here)</label>
        </div>
        <div class="wf-field">
          <label :for="`${state.uid}-required`">Fields required to enter this state</label>
          <input :id="`${state.uid}-required`" class="form-control" :value="state.requiredFields.join(', ')" :aria-describedby="`${state.uid}-required-hint`" @change="state.requiredFields = parseFieldList($event.target.value)" />
          <span :id="`${state.uid}-required-hint`" class="wf-hint">Comma separated: item fields such as description, points, assignee, startDate, endDate, or custom field names.</span>
        </div>
        <p v-for="entry in rowErrors(state)" :key="entry.message" class="wf-error"><i class="bi bi-exclamation-circle" aria-hidden="true"></i> {{ entry.message }}</p>
      </li>
    </ol>
  </section>
</template>
