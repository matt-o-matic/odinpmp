<script setup>
import { computed, ref, watch } from 'vue';

import RequirementsCommentEditor from './RequirementsCommentEditor.vue';
import RequirementsDialog from './RequirementsDialog.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { describeRequirementsError, requirementsErrorCode } from '../../lib/requirements/requirements-errors.js';
import {
  blockingOutstandingCount,
  collectSummarySources,
  decisionWarning,
  normalizeSummaryOutput,
  proposedAnswerStatusChip,
  resolveSourceRefs,
} from '../../lib/requirements/requirements-sources.js';
import { chipToneClass, topicSettled } from '../../lib/requirements/requirements-topics.js';

// "Record a decision" for admins and managers. The statement starts from the
// summary's proposed answer; once recorded it belongs to the person who recorded it.
// It is rich text stored as Markdown, like comments, and opens in a larger editor on demand.
const props = defineProps({
  headingId: { default: 'rq-decision-heading', type: String },
  numbering: { default: null, type: Object },
  projectId: { required: true, type: String },
  // The decision this one replaces, when superseding.
  supersedes: { default: null, type: Object },
  summary: { default: null, type: Object },
  topic: { required: true, type: Object },
});

const emit = defineEmits(['cancel', 'conflict', 'recorded']);

const OUTCOMES = [
  { id: 'agreed', label: 'Agreed' },
  { id: 'decided', label: 'Decided' },
  { id: 'deferred', label: 'Deferred' },
];

const outcome = ref('agreed');
const statement = ref('');
const touched = ref(false);
const saving = ref(false);
const error = ref('');
const statementField = ref(null);
// The larger editor in a dialog; it edits the same statement.
const expanded = ref(false);

const output = computed(() => normalizeSummaryOutput(props.summary?.output ?? null));
const proposedAnswer = computed(() => output.value.proposedAnswer);
const sources = computed(() => collectSummarySources(props.summary?.output ?? null));
// Display order only (C1, C2, ...); the request keeps the summary's citation order.
const sourceLabels = computed(() => resolveSourceRefs(sources.value, props.numbering ?? undefined)
  .map((source) => source.label)
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true })));
// Replacing a decision on a decided topic is not held up by the summary's open items; replacing a deferral is.
const decided = computed(() => topicSettled(props.topic));
const warning = computed(() => decisionWarning(props.summary?.output ?? null, { decided: decided.value }));
const proposedStatus = computed(() => proposedAnswerStatusChip(output.value.proposedAnswerStatus, {
  blocking: decided.value ? 0 : blockingOutstandingCount(props.summary?.output ?? null),
}));
const prefilled = computed(() => Boolean(proposedAnswer.value) && statement.value.trim() === proposedAnswer.value);

watch(
  proposedAnswer,
  (answer) => {
    if (!touched.value) statement.value = answer;
  },
  { immediate: true },
);

// Once someone writes their own statement, a newer proposed answer no longer replaces it.
watch(statement, (value) => {
  if (value.trim() !== proposedAnswer.value.trim()) touched.value = true;
});

async function submit() {
  if (saving.value) return;
  const text = statement.value.trim();
  if (!text) {
    error.value = 'Write the decision before recording it.';
    statementField.value?.focus();
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const result = await apiClient.recordRequirementsDecision(props.projectId, {
      outcome: outcome.value,
      sourceSummaryId: props.summary?.id ?? '',
      sources: sources.value,
      statement: text,
      supersedesId: props.supersedes?.id ?? '',
      topicId: props.topic.id,
    }, authSession.state.token);
    touched.value = false;
    emit('recorded', result);
  } catch (caught) {
    const described = describeRequirementsError(caught, 'Unable to record the decision.');
    // A conflict means someone else decided first: the page reloads and shows their
    // decision in place of this form, so the explanation travels with the event.
    if (['decision_exists', 'decision_version_conflict'].includes(requirementsErrorCode(caught))) emit('conflict', described.message);
    else error.value = described.message;
  } finally {
    saving.value = false;
  }
}

defineExpose({
  focusStatement() {
    statementField.value?.focus();
  },
});
</script>

<template>
  <form class="rq-stack" novalidate @submit.prevent="submit">
    <div class="rq-row rq-row--between rq-row--wrap">
      <h2 :id="headingId" class="rq-eyebrow rq-section-heading" tabindex="-1">{{ supersedes ? 'Replace the decision' : 'Record a decision' }}</h2>
      <span class="rq-xs rq-muted">Managers and admins</span>
    </div>

    <fieldset class="rq-field">
      <legend class="visually-hidden">Outcome</legend>
      <div class="rq-seg rq-seg--block">
        <label v-for="option in OUTCOMES" :key="option.id" class="rq-seg__option">
          <input v-model="outcome" type="radio" :name="`rq-outcome-${topic.id}`" :value="option.id" />
          <span>{{ option.label }}</span>
        </label>
      </div>
    </fieldset>

    <p v-if="proposedStatus" class="rq-row rq-row--tight rq-row--wrap rq-xs mb-0">
      <span class="rq-muted">Odin’s proposed answer</span>
      <span class="rq-chip rq-chip--wrap" :class="chipToneClass(proposedStatus.tone)">{{ proposedStatus.label }}</span>
    </p>

    <div class="rq-field">
      <div class="rq-row rq-row--between">
        <span id="rq-decision-statement-label" class="rq-xs rq-muted">Decision statement</span>
        <button class="rq-text-action" type="button" @click="expanded = true">
          <i class="bi bi-arrows-angle-expand" aria-hidden="true"></i> Open larger editor
        </button>
      </div>
      <RequirementsCommentEditor
        ref="statementField"
        v-model="statement"
        labelled-by="rq-decision-statement-label"
        min-height="5rem"
        placeholder="State what was decided."
      />
    </div>

    <p id="rq-decision-note" class="rq-xs rq-muted mb-0">
      <i class="bi bi-info-circle" aria-hidden="true"></i>
      <template v-if="prefilled"> Prefilled from the summary. Rewrite it as needed: once recorded, the decision is yours.</template>
      <template v-else> Once recorded, the decision is yours.</template>
      <template v-if="sourceLabels.length"> Sources {{ sourceLabels.join(', ') }} are attached.</template>
    </p>

    <div class="rq-row rq-row--between rq-row--wrap">
      <span v-if="warning" class="rq-xs rq-decision-warning"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> {{ warning }}</span>
      <span v-else></span>
      <span class="rq-row rq-row--tight">
        <button v-if="supersedes" class="ghost-button ghost-button--compact" type="button" :disabled="saving" @click="emit('cancel')">Cancel</button>
        <button class="primary-button primary-button--compact" type="submit" :disabled="saving">
          {{ saving ? 'Recording…' : 'Record decision' }}
        </button>
      </span>
    </div>

    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
  </form>

  <!-- Outside the form: the dialog has a form of its own. -->
  <RequirementsDialog :open="expanded" title="Edit decision statement" @close="expanded = false" @submit="expanded = false">
    <span id="rq-decision-statement-large-label" class="visually-hidden">Decision statement</span>
    <RequirementsCommentEditor
      v-if="expanded"
      v-model="statement"
      labelled-by="rq-decision-statement-large-label"
      min-height="22rem"
      placeholder="State what was decided."
    />
    <p class="rq-xs rq-muted mb-0">Changes here are the same statement; record the decision from the form.</p>
    <template #footer>
      <button class="primary-button" type="submit">Done</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.rq-decision-warning {
  color: var(--rq-outstanding);
  font-weight: 600;
}
</style>
