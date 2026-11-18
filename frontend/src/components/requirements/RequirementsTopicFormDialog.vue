<script setup>
import { computed, reactive, ref, watch } from 'vue';

import RequirementsDialog from './RequirementsDialog.vue';
import RequirementsPeopleFields from './RequirementsPeopleFields.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { assignmentKeys, assignmentsFromKeys, peopleOptions, sameAssignmentKeys } from '../../lib/requirements/requirements-topics.js';
import { trackLabel } from '../../lib/requirements/requirements-tracks.js';

// Add a topic, or edit one: its wording on Details and its owner and other people on People.
// One form, one submit. People are sent only when they changed, so an unchanged list never
// invites anyone again.
const props = defineProps({
  briefLines: { default: () => [], type: Array },
  canAssign: { default: true, type: Boolean },
  // 'details' or 'people'.
  initialTab: { default: 'details', type: String },
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  stakeholders: { default: () => [], type: Array },
  // Present when editing.
  topic: { default: null, type: Object },
  track: { required: true, type: String },
  users: { default: () => [], type: Array },
});

const emit = defineEmits(['close', 'saved']);

const TABS = [{ id: 'details', label: 'Details' }, { id: 'people', label: 'People' }];
const fields = reactive({ prompt: '', rationale: '', settles: '', sourceRef: '', suggestedOwnerRole: '' });
const people = reactive({ involved: [], owner: '', required: [] });
const tab = ref('details');
const saving = ref(false);
const error = ref('');
const editing = computed(() => Boolean(props.topic?.id));
const title = computed(() => (editing.value ? 'Edit topic' : `Add a topic to ${trackLabel(props.track)}`));
const options = computed(() => peopleOptions({ stakeholders: props.stakeholders, users: props.users }));
const ids = 'rq-topic-form';

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = '';
    tab.value = props.canAssign && props.initialTab === 'people' ? 'people' : 'details';
    Object.assign(fields, {
      prompt: props.topic?.prompt ?? '',
      rationale: props.topic?.rationale ?? '',
      settles: props.topic?.settles ?? '',
      sourceRef: props.topic?.sourceRef ?? '',
      suggestedOwnerRole: props.topic?.suggestedOwnerRole ?? '',
    });
    Object.assign(people, assignmentKeys(props.topic?.assignments ?? []));
  },
  { immediate: true },
);

function onTabKeydown(event, id) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = TABS.findIndex((entry) => entry.id === id);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
  tab.value = TABS[next].id;
  document.getElementById(`${ids}-tab-${TABS[next].id}`)?.focus();
}

function lineOptionLabel(line, index) {
  const text = String(line.text ?? '').replace(/\s+/g, ' ').trim();
  return `${index + 1}. ${line.label}: ${text.length > 70 ? `${text.slice(0, 69)}…` : text}`;
}

async function submit() {
  if (saving.value) return;
  if (!fields.prompt.trim()) {
    tab.value = 'details';
    error.value = 'Write the question this topic should settle.';
    return;
  }
  saving.value = true;
  error.value = '';
  const text = {
    prompt: fields.prompt.trim(),
    rationale: fields.rationale.trim(),
    settles: fields.settles.trim(),
    suggestedOwnerRole: fields.suggestedOwnerRole.trim(),
  };
  const current = props.topic?.assignments ?? [];
  const peopleChanged = props.canAssign && !sameAssignmentKeys(people, assignmentKeys(current));
  const assignments = peopleChanged ? assignmentsFromKeys({ current, involved: people.involved, options: options.value, owner: people.owner, required: people.required }) : undefined;
  try {
    const token = authSession.state.token;
    const result = editing.value
      ? await apiClient.updateRequirementsTopic(props.projectId, props.topic.id, { ...text, ...(assignments ? { assignments } : {}) }, token)
      : await apiClient.createRequirementsTopic(props.projectId, props.track, { ...text, sourceRef: fields.sourceRef || null, ...(assignments ? { assignments } : {}) }, token);
    emit('saved', result.topic, { peopleChanged });
  } catch (caught) {
    error.value = describeRequirementsError(caught, editing.value ? 'Unable to save the topic.' : 'Unable to add the topic.').message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <RequirementsDialog :busy="saving" :open="open" :title="title" @close="emit('close')" @submit="submit">
    <div v-if="canAssign" class="rq-side__tabs" role="tablist" aria-label="Topic sections">
      <button
        v-for="entry in TABS"
        :id="`${ids}-tab-${entry.id}`"
        :key="entry.id"
        class="rq-side__tab"
        :class="{ 'rq-side__tab--on': tab === entry.id }"
        type="button"
        role="tab"
        :aria-selected="tab === entry.id ? 'true' : 'false'"
        :aria-controls="`${ids}-panel`"
        :tabindex="tab === entry.id ? 0 : -1"
        @click="tab = entry.id"
        @keydown="onTabKeydown($event, entry.id)"
      >{{ entry.label }}<template v-if="entry.id === 'people' && (people.owner || people.involved.length)"> · {{ (people.owner ? 1 : 0) + people.involved.length }}</template></button>
    </div>

    <div :id="`${ids}-panel`" class="rq-stack" :role="canAssign ? 'tabpanel' : undefined" :aria-labelledby="canAssign ? `${ids}-tab-${tab}` : undefined">
      <template v-if="tab === 'details'">
        <div class="rq-field">
          <label for="rq-topic-prompt">Question</label>
          <textarea
            id="rq-topic-prompt"
            v-model="fields.prompt"
            class="form-control"
            data-autofocus
            maxlength="2000"
            required
            rows="3"
            aria-describedby="rq-topic-prompt-hint"
          ></textarea>
          <p id="rq-topic-prompt-hint" class="rq-field__hint">Ask one thing the team or stakeholders need to settle.</p>
        </div>
        <div class="rq-field">
          <label for="rq-topic-rationale">Why it matters <span class="rq-muted">(optional)</span></label>
          <textarea id="rq-topic-rationale" v-model="fields.rationale" class="form-control" maxlength="2000" rows="2"></textarea>
        </div>
        <div class="rq-field">
          <label for="rq-topic-settles">What it settles <span class="rq-muted">(optional)</span></label>
          <input id="rq-topic-settles" v-model="fields.settles" class="form-control" maxlength="160" placeholder="For example: booking flow" type="text" />
        </div>
        <div v-if="!editing" class="rq-field">
          <label for="rq-topic-source">Brief line <span class="rq-muted">(optional)</span></label>
          <select id="rq-topic-source" v-model="fields.sourceRef" class="form-select">
            <option value="">Not from a brief line</option>
            <option v-for="(line, index) in briefLines" :key="line.ref" :value="line.ref">{{ lineOptionLabel(line, index) }}</option>
          </select>
        </div>
        <div class="rq-field">
          <label for="rq-topic-owner-role">Suggested owner role <span class="rq-muted">(optional)</span></label>
          <input id="rq-topic-owner-role" v-model="fields.suggestedOwnerRole" class="form-control" maxlength="120" placeholder="For example: Finance" type="text" />
        </div>
      </template>
      <RequirementsPeopleFields
        v-else
        v-model:involved="people.involved"
        v-model:owner="people.owner"
        v-model:required="people.required"
        id-prefix="rq-topic-people"
        :options="options"
      />
    </div>

    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="saving" @click="emit('close')">Cancel</button>
      <button class="primary-button" type="submit" :disabled="saving">
        {{ saving ? 'Saving…' : editing ? 'Save changes' : 'Add topic' }}
      </button>
    </template>
  </RequirementsDialog>
</template>
