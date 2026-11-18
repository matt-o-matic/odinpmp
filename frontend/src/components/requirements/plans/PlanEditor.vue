<script setup>
import { computed, reactive, watch } from 'vue';

import './plans.css';
import { planEditErrors, planEditForm } from '../../../lib/requirements/requirements-plans.js';

// Editing one plan version in place of the read view: objective, scope, not in scope, and
// acceptance criteria, each item citing decisions by D-label. Editing an approved plan
// saves a new draft version; the approved one stays as it is.
const props = defineProps({
  // Server-side problems: [{ section, index, message }] plus a general message.
  error: { default: '', type: String },
  // A form to start from instead of the plan (reapplying edits after a conflict).
  initialForm: { default: null, type: Object },
  issues: { default: () => [], type: Array },
  labels: { default: () => new Map(), type: Map },
  plan: { required: true, type: Object },
  saving: { default: false, type: Boolean },
});

const emit = defineEmits(['cancel', 'save']);

const form = reactive({ criteria: [], nonGoals: [], objective: '', revision: 1, scope: [] });
const local = reactive({ errors: [] });

watch(
  () => [props.plan?.id, props.plan?.revision, props.initialForm],
  () => {
    const source = props.initialForm
      ? { ...plainCopy(props.initialForm), revision: props.plan.revision }
      : planEditForm(props.plan, { labels: props.labels });
    Object.assign(form, source);
    local.errors = [];
  },
  { immediate: true },
);

const createsVersion = computed(() => props.plan.status === 'approved');
const allErrors = computed(() => [...local.errors, ...props.issues]);
const submitLabel = computed(() => {
  if (props.saving) return 'Saving…';
  return createsVersion.value ? `Save as draft v${props.plan.version + 1}` : 'Save draft';
});

// Reactive proxies can't go through structuredClone; the form is plain data.
function plainCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

const SECTIONS = Object.freeze({ criteria: 'Acceptance criterion', nonGoals: 'Not in scope item', scope: 'Scope item' });

function fieldError(section, index) {
  return allErrors.value.filter((issue) => issue.section === section && Number(issue.index) === index).map((issue) => issue.message).join(' ');
}

function addItem(section) {
  if (section === 'criteria') form.criteria.push({ decisions: '', id: '', scenario: '' });
  else form[section].push({ decisions: '', text: '' });
}

function removeItem(section, index) {
  form[section].splice(index, 1);
}

function submit() {
  local.errors = planEditErrors(form);
  if (local.errors.length > 0) return;
  emit('save', plainCopy(form));
}
</script>

<template>
  <form class="rq-stack" novalidate :aria-busy="saving ? 'true' : 'false'" @submit.prevent="submit">
    <p v-if="createsVersion" class="rq-notice rq-small mb-0" role="note">
      <i class="bi bi-info-circle" aria-hidden="true"></i>
      Saving creates draft v{{ plan.version + 1 }} from this approved plan. v{{ plan.version }} stays approved, with its owner, until someone approves the new draft.
    </p>

    <div v-if="error || allErrors.length" class="error-banner" role="alert">
      <p class="mb-0">{{ error || 'Some items need attention before saving.' }}</p>
      <ul v-if="allErrors.length" class="rq-plan-edit-errors rq-small">
        <li v-for="(issue, index) in allErrors" :key="`issue-${index}`">{{ issue.message }}</li>
      </ul>
    </div>

    <div class="rq-field">
      <label for="rq-plan-objective">Objective</label>
      <textarea id="rq-plan-objective" v-model="form.objective" class="form-control" maxlength="1000" rows="2"></textarea>
    </div>

    <fieldset v-for="section in ['scope', 'nonGoals']" :key="section" class="rq-field">
      <legend>{{ section === 'scope' ? 'Scope' : 'Not in scope' }}</legend>
      <ul class="rq-plan-edit-list">
        <li v-for="(item, index) in form[section]" :key="`${section}-${index}`" class="rq-plan-edit-item">
          <div class="rq-field">
            <label :for="`rq-plan-${section}-${index}`" class="rq-xs">{{ SECTIONS[section] }} {{ index + 1 }}</label>
            <textarea
              :id="`rq-plan-${section}-${index}`"
              v-model="item.text"
              class="form-control"
              maxlength="600"
              rows="2"
              :aria-invalid="fieldError(section, index) ? 'true' : undefined"
            ></textarea>
          </div>
          <div class="rq-field">
            <label :for="`rq-plan-${section}-${index}-decisions`" class="rq-xs">Decisions<span class="visually-hidden"> for {{ SECTIONS[section].toLowerCase() }} {{ index + 1 }}</span></label>
            <input :id="`rq-plan-${section}-${index}-decisions`" v-model="item.decisions" class="form-control" placeholder="D-07, D-11" type="text" />
          </div>
          <button class="ghost-button ghost-button--compact" type="button" :aria-label="`Remove ${SECTIONS[section].toLowerCase()} ${index + 1}`" @click="removeItem(section, index)">Remove</button>
        </li>
      </ul>
      <button class="ghost-button ghost-button--compact rq-plan-add" type="button" @click="addItem(section)">
        <i class="bi bi-plus-lg" aria-hidden="true"></i>{{ section === 'scope' ? 'Add scope item' : 'Add item not in scope' }}
      </button>
    </fieldset>

    <fieldset class="rq-field">
      <legend>Acceptance criteria</legend>
      <p class="rq-field__hint">Each criterion cites the decisions it comes from, by label (D-07). New criteria get the next id when saved.</p>
      <ul class="rq-plan-edit-list">
        <li v-for="(criterion, index) in form.criteria" :key="`criterion-${index}`" class="rq-plan-edit-item rq-plan-edit-item--criterion">
          <span class="rq-plan-edit-item__id">{{ criterion.id || 'New' }}</span>
          <div class="rq-field">
            <label :for="`rq-plan-criterion-${index}`" class="rq-xs">Scenario and expected result<span class="visually-hidden"> for acceptance criterion {{ criterion.id || `${index + 1} (new)` }}</span></label>
            <textarea
              :id="`rq-plan-criterion-${index}`"
              v-model="criterion.scenario"
              class="form-control"
              maxlength="1000"
              rows="2"
              :aria-invalid="fieldError('criteria', index) ? 'true' : undefined"
            ></textarea>
          </div>
          <div class="rq-field">
            <label :for="`rq-plan-criterion-${index}-decisions`" class="rq-xs">Decisions<span class="visually-hidden"> for acceptance criterion {{ criterion.id || `${index + 1} (new)` }}</span></label>
            <input :id="`rq-plan-criterion-${index}-decisions`" v-model="criterion.decisions" class="form-control" placeholder="D-07" type="text" />
          </div>
          <button class="ghost-button ghost-button--compact" type="button" :aria-label="`Remove acceptance criterion ${criterion.id || index + 1}`" @click="removeItem('criteria', index)">Remove</button>
        </li>
      </ul>
      <button class="ghost-button ghost-button--compact rq-plan-add" type="button" @click="addItem('criteria')">
        <i class="bi bi-plus-lg" aria-hidden="true"></i>Add criterion
      </button>
    </fieldset>

    <div class="rq-row rq-row--wrap rq-plan-edit-foot">
      <button class="ghost-button" type="button" :disabled="saving" @click="emit('cancel')">Cancel</button>
      <button class="primary-button" type="submit" :disabled="saving">{{ submitLabel }}</button>
    </div>
  </form>
</template>
