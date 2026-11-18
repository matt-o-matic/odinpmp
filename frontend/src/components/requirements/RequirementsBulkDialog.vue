<script setup>
import { computed, ref, watch } from 'vue';

import RequirementsCommentEditor from './RequirementsCommentEditor.vue';
import RequirementsDialog from './RequirementsDialog.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { rowProposedAnswer } from '../../lib/requirements/requirements-topics.js';

// One action over the topics selected on the register. The server checks each topic as it
// would one at a time and reports a result per topic; this dialog says up front what will be
// left alone, then hands the result back.
const props = defineProps({
  // agree | assign | defer | delete | dismiss | reopen
  action: { default: '', type: String },
  open: { default: false, type: Boolean },
  // peopleOptions(): project members, then stakeholders.
  options: { default: () => [], type: Array },
  projectId: { required: true, type: String },
  // The selected register rows.
  topics: { default: () => [], type: Array },
});

const emit = defineEmits(['close', 'done']);

const KEEP = '__keep';
const owner = ref(KEEP);
const add = ref([]);
const remove = ref([]);
const statement = ref('');
const saving = ref(false);
const error = ref('');

const count = computed(() => props.topics.length);
const noun = computed(() => (count.value === 1 ? 'topic' : 'topics'));
const COPY = {
  agree: { label: 'Agree', title: 'Agree on' },
  assign: { label: 'Save people', title: 'Change people on' },
  defer: { label: 'Defer', title: 'Defer' },
  delete: { label: 'Delete', title: 'Delete' },
  dismiss: { label: 'Dismiss', title: 'Dismiss' },
  reopen: { label: 'Reopen', title: 'Reopen' },
};
const title = computed(() => `${COPY[props.action]?.title ?? 'Change'} ${count.value} ${noun.value}`);
const submitLabel = computed(() => (saving.value ? 'Saving…' : `${COPY[props.action]?.label ?? 'Save'} ${count.value} ${noun.value}`));

const undecided = computed(() => props.topics.filter((row) => row.state !== 'decided' && row.state !== 'dismissed'));
const agreeable = computed(() => undecided.value.filter((row) => rowProposedAnswer(row)));
const leftAlone = computed(() => {
  if (props.action === 'agree') return count.value - agreeable.value.length;
  if (props.action === 'defer') return count.value - undecided.value.length;
  if (props.action === 'dismiss') return props.topics.filter((row) => row.state === 'decided' || row.state === 'dismissed').length;
  if (props.action === 'reopen') return props.topics.filter((row) => row.state !== 'dismissed').length;
  return 0;
});
const members = computed(() => props.options.filter((option) => option.group === 'members'));
const stakeholders = computed(() => props.options.filter((option) => option.group === 'stakeholders'));
// Only people already on a selected topic can be taken off.
const onSelected = computed(() => {
  const keys = new Set(props.topics.flatMap((row) => (row.assignments ?? []).map((assignment) => `${assignment.actorType}:${assignment.actorId}`)));
  return props.options.filter((option) => keys.has(option.key));
});

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    owner.value = KEEP;
    add.value = [];
    remove.value = [];
    statement.value = '';
    error.value = '';
  },
);

const person = (key) => {
  const option = props.options.find((entry) => entry.key === key);
  return option ? { actorId: option.actorId, actorType: option.actorType } : null;
};

async function submit() {
  if (saving.value || !count.value) return;
  const payload = { action: props.action, topicIds: props.topics.map((row) => row.id) };
  if (props.action === 'defer') {
    if (!statement.value.trim()) {
      error.value = 'Say why these topics are deferred.';
      return;
    }
    payload.statement = statement.value.trim();
  }
  if (props.action === 'assign') {
    const assign = {
      add: add.value.map(person).filter(Boolean),
      remove: remove.value.map(person).filter(Boolean),
      ...(owner.value === KEEP ? {} : { owner: owner.value ? person(owner.value) : null }),
    };
    if (!assign.add.length && !assign.remove.length && assign.owner === undefined) {
      error.value = 'Choose an owner, people to add, or people to take off.';
      return;
    }
    payload.assign = assign;
  }
  saving.value = true;
  error.value = '';
  try {
    emit('done', await apiClient.bulkRequirementsTopics(props.projectId, payload, authSession.state.token));
  } catch (caught) {
    error.value = describeRequirementsError(caught, 'Unable to change these topics.').message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <RequirementsDialog :busy="saving" :open="open" :title="title" @close="emit('close')" @submit="submit">
    <details class="rq-bulk__topics">
      <summary>{{ count }} selected {{ noun }}</summary>
      <ul class="rq-small mb-0">
        <li v-for="row in topics" :key="row.id">{{ row.prompt }}</li>
      </ul>
    </details>

    <template v-if="action === 'agree'">
      <p class="mb-0">Records <strong>Agreed</strong> on each topic, using that topic’s own Odin proposed answer as the decision, with the summary’s sources attached.</p>
      <ul v-if="agreeable.length" class="rq-bulk__answers">
        <li v-for="row in agreeable" :key="row.id">
          <span class="rq-small">{{ row.prompt }}</span>
          <span class="rq-xs rq-muted d-block">{{ rowProposedAnswer(row) }}</span>
        </li>
      </ul>
    </template>

    <div v-else-if="action === 'defer'" class="rq-field">
      <span id="rq-bulk-defer-label" class="rq-field__label">Why they wait</span>
      <!-- Rich text, like every decision statement. -->
      <RequirementsCommentEditor v-model="statement" labelled-by="rq-bulk-defer-label" min-height="6rem" placeholder="Say why these wait." />
      <p class="rq-field__hint">Recorded as the Deferred decision on each topic. Deferred topics stay open.</p>
    </div>

    <p v-else-if="action === 'dismiss'" class="mb-0">Dismissed topics leave the open lists and keep their discussion. Reopen them from the Dismissed filter.</p>
    <p v-else-if="action === 'reopen'" class="mb-0">Reopened topics are open for discussion again.</p>
    <p v-else-if="action === 'delete'" class="mb-0">Deleting removes a topic for everyone. Topics with comments, review answers, decisions, stakeholders or files are kept; dismiss those instead.</p>

    <template v-else-if="action === 'assign'">
      <div class="rq-field">
        <label for="rq-bulk-owner">Owner</label>
        <select id="rq-bulk-owner" v-model="owner" class="form-select">
          <option :value="KEEP">Keep each topic’s owner</option>
          <option value="">No owner</option>
          <optgroup v-if="members.length" label="Project members">
            <option v-for="option in members" :key="option.key" :value="option.key">{{ option.label }}</option>
          </optgroup>
          <optgroup v-if="stakeholders.length" label="Stakeholders">
            <option v-for="option in stakeholders" :key="option.key" :value="option.key">{{ option.label }}</option>
          </optgroup>
        </select>
      </div>
      <fieldset class="rq-field">
        <legend>Also involve</legend>
        <ul v-if="options.length" class="rq-checklist">
          <li v-for="option in options" :key="option.key">
            <label>
              <input v-model="add" class="form-check-input mt-0" type="checkbox" :value="option.key" />
              <span>{{ option.label }} <span v-if="option.detail" class="rq-xs rq-muted">· {{ option.detail }}</span></span>
            </label>
          </li>
        </ul>
        <p v-else class="rq-field__hint">No project members or stakeholders yet.</p>
      </fieldset>
      <fieldset v-if="onSelected.length" class="rq-field">
        <legend>Take off these topics</legend>
        <ul class="rq-checklist">
          <li v-for="option in onSelected" :key="option.key">
            <label>
              <input v-model="remove" class="form-check-input mt-0" type="checkbox" :value="option.key" />
              <span>{{ option.label }}</span>
            </label>
          </li>
        </ul>
      </fieldset>
      <p class="rq-field__hint">Stakeholders you add get an email with a link to answer.</p>
    </template>

    <p v-if="leftAlone" class="rq-notice mb-0">
      <template v-if="action === 'agree'">{{ leftAlone }} of these will be left as they are: they have no Odin proposed answer yet, or already have a decision.</template>
      <template v-else-if="action === 'defer'">{{ leftAlone }} already have a decision or are dismissed, and will be left as they are.</template>
      <template v-else-if="action === 'dismiss'">{{ leftAlone }} are decided or already dismissed, and will be left as they are.</template>
      <template v-else>{{ leftAlone }} are not dismissed, and will be left as they are.</template>
    </p>
    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="saving" @click="emit('close')">Cancel</button>
      <button class="primary-button" :class="{ 'rq-danger-button': action === 'delete' }" type="submit" :disabled="saving || (action === 'agree' && !agreeable.length)">{{ submitLabel }}</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.rq-bulk__topics summary {
  cursor: pointer;
  font-weight: 600;
}

.rq-bulk__topics ul,
.rq-bulk__answers {
  display: grid;
  gap: 0.35rem;
  margin: 0.5rem 0 0;
  padding-left: 1.1rem;
}

.rq-bulk__answers {
  max-height: 16rem;
  overflow-y: auto;
}

.rq-danger-button {
  border-color: #8f1b13;
  background: #b42318;
}
</style>
